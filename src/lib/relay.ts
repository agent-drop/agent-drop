import { AwsClient } from "aws4fetch";
import type { Env } from "../types";
import { generateId } from "./id";

// Encode sender email for use in relay address
// sender@example.com -> sender_at_example.com
export function encodeEmail(email: string): string {
	return email.replace(/@/g, "_at_");
}

// Decode encoded sender back to email
// sender_at_example.com -> sender@example.com
export function decodeEmail(encoded: string): string {
	// Find last occurrence of _at_ (in case local part contains it somehow)
	const idx = encoded.lastIndexOf("_at_");
	if (idx < 0) return encoded;
	return encoded.slice(0, idx) + "@" + encoded.slice(idx + 4);
}

// Build relay reply-to address
// sender@example.com + mask j-7k9m -> sender_at_example.com+j-7k9m@example.com
export function buildRelayAddress(senderEmail: string, maskId: string, domain: string): string {
	return `${encodeEmail(senderEmail)}+${maskId}@${domain}`;
}

// Parse a relay reply address from the local part
// sender_at_example.com+j-7k9m -> { sender: "sender@example.com", maskId: "j-7k9m" }
export function parseRelayAddress(localPart: string): { sender: string; maskId: string } | null {
	const plusIdx = localPart.lastIndexOf("+");
	if (plusIdx < 0) return null;
	const encoded = localPart.slice(0, plusIdx);
	const maskId = localPart.slice(plusIdx + 1);
	if (!encoded.includes("_at_")) return null;
	return { sender: decodeEmail(encoded), maskId };
}

// Check if a local part is a relay reply (contains encoded sender)
export function isRelayReply(localPart: string): boolean {
	return localPart.includes("_at_") && localPart.includes("+");
}

// Find the relay rule that matches a mask ID
export async function findRelayRule(
	env: Env,
	maskId: string,
): Promise<{ target: string; pattern: string } | null> {
	// Get all relay rules
	const { results } = await env.DB.prepare(
		"SELECT pattern, target FROM drop_rules WHERE type = 'relay' AND enabled = 1 ORDER BY priority DESC",
	).all<{ pattern: string; target: string }>();

	for (const rule of results) {
		// Check if mask matches the rule pattern
		if (rule.pattern === "*") return rule;
		if (rule.pattern === maskId) return rule;
		if (rule.pattern.endsWith("-*")) {
			const prefix = rule.pattern.slice(0, -2);
			if (maskId.startsWith(prefix + "-")) return rule;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// MIME assembly
// ---------------------------------------------------------------------------

export interface MimeAttachment {
	filename: string;
	contentType: string;
	contentBase64: string; // already base64-encoded bytes
	inline?: boolean;
	cid?: string;
}

// base64-encode a UTF-8 string
function b64(s: string): string {
	return btoa(unescape(encodeURIComponent(s)));
}

// wrap a base64 blob to 76-char lines (RFC 2045)
function wrap76(s: string): string {
	return (s.match(/.{1,76}/g) || []).join("\r\n");
}

// RFC 2047-encode a header value if it contains non-ASCII
function encodeHeaderWord(s: string): string {
	return /^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
}

interface MimeEntity {
	ct: string;
	headers?: string[];
	body: string;
}

function renderPart(e: MimeEntity): string {
	return [`Content-Type: ${e.ct}`, ...(e.headers || []), "", e.body].join("\r\n");
}

function leafText(mime: string, text: string): MimeEntity {
	return {
		ct: `${mime}; charset=UTF-8`,
		headers: ["Content-Transfer-Encoding: base64"],
		body: wrap76(b64(text)),
	};
}

function leafAttachment(a: MimeAttachment): MimeEntity {
	const name = a.filename.replace(/"/g, "");
	const disp = a.inline ? "inline" : "attachment";
	const headers = [
		"Content-Transfer-Encoding: base64",
		`Content-Disposition: ${disp}; filename="${name}"`,
	];
	if (a.cid) headers.push(`Content-ID: <${a.cid}>`);
	return {
		ct: `${a.contentType}; name="${name}"`,
		headers,
		body: wrap76(a.contentBase64),
	};
}

function multipart(subtype: string, parts: MimeEntity[]): MimeEntity {
	const boundary = `----=_Part_${crypto.randomUUID()}`;
	const body = [
		...parts.flatMap((p) => [`--${boundary}`, renderPart(p)]),
		`--${boundary}--`,
	].join("\r\n");
	return { ct: `multipart/${subtype}; boundary="${boundary}"`, body };
}

// Build a raw MIME email for SES SendRawEmail.
// Nesting: multipart/mixed[ multipart/related[ multipart/alternative, inline... ], attachments... ]
export function buildRawEmail(opts: {
	from: string;
	to: string | string[];
	cc?: string | string[];
	replyTo?: string;
	subject: string;
	textBody?: string;
	htmlBody?: string;
	inReplyTo?: string;
	references?: string;
	attachments?: MimeAttachment[];
}): string {
	const toList = (Array.isArray(opts.to) ? opts.to : [opts.to]).filter(Boolean);
	const ccList = (Array.isArray(opts.cc) ? opts.cc : opts.cc ? [opts.cc] : []).filter(Boolean);
	const messageId = `<${crypto.randomUUID()}@example.com>`;
	const date = new Date().toUTCString();

	const headers = [
		`From: ${opts.from}`,
		`To: ${toList.join(", ")}`,
		ccList.length ? `Cc: ${ccList.join(", ")}` : null,
		opts.replyTo ? `Reply-To: ${opts.replyTo}` : null,
		`Subject: ${encodeHeaderWord(opts.subject)}`,
		`Date: ${date}`,
		`Message-ID: ${messageId}`,
		opts.inReplyTo ? `In-Reply-To: ${opts.inReplyTo}` : null,
		opts.references ? `References: ${opts.references}` : null,
		`MIME-Version: 1.0`,
	].filter(Boolean) as string[];

	// 1. body (alternative if both, else single)
	let body: MimeEntity;
	if (opts.textBody && opts.htmlBody) {
		body = multipart("alternative", [
			leafText("text/plain", opts.textBody),
			leafText("text/html", opts.htmlBody),
		]);
	} else if (opts.htmlBody) {
		body = leafText("text/html", opts.htmlBody);
	} else {
		body = leafText("text/plain", opts.textBody || "");
	}

	const atts = opts.attachments || [];
	const inlines = atts.filter((a) => a.inline);
	const regular = atts.filter((a) => !a.inline);

	// 2. related wrapper for inline (cid) images
	let related = body;
	if (inlines.length) {
		related = multipart("related", [body, ...inlines.map(leafAttachment)]);
	}

	// 3. mixed wrapper for regular attachments
	let root = related;
	if (regular.length) {
		root = multipart("mixed", [related, ...regular.map(leafAttachment)]);
	}

	return [
		...headers,
		`Content-Type: ${root.ct}`,
		...(root.headers || []),
		"",
		root.body,
	].join("\r\n");
}

// Send raw email via SES. Optional explicit destination drives the envelope
// (and keeps Bcc recipients out of the visible headers).
export async function sendRawEmail(
	env: Env,
	rawMessage: string,
	destination?: { to?: string[]; cc?: string[]; bcc?: string[] },
): Promise<string> {
	const ses = new AwsClient({
		accessKeyId: env.AWS_ACCESS_KEY_ID,
		secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
		region: env.SES_REGION,
		service: "ses",
	});

	const encoded = btoa(unescape(encodeURIComponent(rawMessage)));

	const payload: Record<string, unknown> = { Content: { Raw: { Data: encoded } } };
	if (destination) {
		const dest: Record<string, string[]> = {};
		if (destination.to?.length) dest.ToAddresses = destination.to;
		if (destination.cc?.length) dest.CcAddresses = destination.cc;
		if (destination.bcc?.length) dest.BccAddresses = destination.bcc;
		payload.Destination = dest;
	}

	const res = await ses.fetch(
		`https://email.${env.SES_REGION}.amazonaws.com/v2/email/outbound-emails`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		},
	);

	if (!res.ok) {
		const err = await res.text();
		throw new Error(`SES SendRawEmail ${res.status}: ${err}`);
	}

	const result = (await res.json()) as { MessageId: string };
	return result.MessageId;
}

// Queue a relay email for delivery
export async function enqueueRelay(
	env: Env,
	opts: {
		maskId: string;
		direction: "inbound" | "reply";
		from: string;
		to: string;
		replyTo?: string;
		subject: string;
		textBody?: string;
		htmlBody?: string;
		inReplyTo?: string;
		references?: string;
	},
): Promise<string> {
	const logId = generateId();
	const rawEmail = buildRawEmail(opts);

	await env.DB.prepare(
		`INSERT INTO delivery_log (id, drop_id, rule_id, type, target, status, attempts, created_at)
		VALUES (?, ?, ?, 'relay', ?, 'queued', 0, ?)`,
	).bind(logId, opts.maskId, `relay:${opts.direction}`, opts.to, Date.now()).run();

	await env.WEBHOOK_QUEUE.send({
		type: "relay",
		logId,
		maskId: opts.maskId,
		direction: opts.direction,
		rawEmail,
		from: opts.from,
		to: opts.to,
		subject: opts.subject,
		attempt: 0,
		firstAttemptAt: Date.now(),
	});

	return logId;
}

// Process a relay message from the queue
export async function processRelayMessage(
	msg: Message<any>,
	env: Env,
): Promise<void> {
	const relay = msg.body;
	const MAX_AGE_MS = 24 * 60 * 60 * 1000;

	if (Date.now() - relay.firstAttemptAt > MAX_AGE_MS) {
		await env.DB.prepare(
			"UPDATE delivery_log SET status = 'failed', error = 'exceeded 24h retry window', completed_at = ? WHERE id = ?",
		).bind(Date.now(), relay.logId).run();
		msg.ack();
		return;
	}

	try {
		const messageId = await sendRawEmail(env, relay.rawEmail);

		await env.DB.prepare(
			"UPDATE delivery_log SET status = 'success', attempts = ?, completed_at = ?, error = ? WHERE id = ?",
		).bind(relay.attempt + 1, Date.now(), `ses:${messageId}`, relay.logId).run();
		msg.ack();
	} catch (err: any) {
		await env.DB.prepare(
			"UPDATE delivery_log SET status = 'retrying', error = ?, attempts = ? WHERE id = ?",
		).bind(err.message || "SES error", relay.attempt + 1, relay.logId).run();

		const delaySec = Math.min(2 ** (relay.attempt + 1), 1200);
		msg.retry({ delaySeconds: delaySec });
	}
}
