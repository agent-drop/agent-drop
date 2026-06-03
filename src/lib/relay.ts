import { EmailMessage } from "cloudflare:email";
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

// base64-encode raw bytes (ArrayBuffer / typed array). Strings are UTF-8 encoded.
function bytesToBase64(data: ArrayBuffer | ArrayBufferView | string): string {
	if (typeof data === "string") return b64(data);
	const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

// Forward a received email to `to` via the Cloudflare Email Sending binding.
// message.forward() only delivers to CF-verified destinations; re-sending via the
// binding delivers to any address. The From is rewritten to the box address (so
// example.com DKIM/SPF apply), with the original sender preserved in Reply-To.
export async function forwardViaBinding(
	env: Env,
	opts: {
		box: string;
		to: string;
		from: string; // original sender address
		fromName?: string | null;
		subject?: string | null;
		textBody?: string;
		htmlBody?: string;
		attachments?: { filename?: string; mimeType?: string; content: ArrayBuffer | ArrayBufferView | string; contentId?: string; disposition?: string }[];
		messageId?: string | null;
	},
): Promise<string> {
	const boxAddr = `${opts.box}@${env.DOMAIN}`;
	const label = (opts.fromName || opts.from || "").replace(/"/g, "");
	const fromHeader = `"${label} (via ${boxAddr})" <${boxAddr}>`;

	const attachments: MimeAttachment[] = (opts.attachments || []).map((a) => ({
		filename: a.filename || "attachment",
		contentType: a.mimeType || "application/octet-stream",
		contentBase64: bytesToBase64(a.content),
		inline: a.disposition === "inline" || !!a.contentId,
		cid: a.contentId,
	}));

	const raw = buildRawEmail({
		from: fromHeader,
		to: opts.to,
		replyTo: opts.from || undefined,
		subject: opts.subject || "(no subject)",
		textBody: opts.textBody,
		htmlBody: opts.htmlBody,
		references: opts.messageId || undefined,
		attachments,
	});

	return sendRawViaBinding(env, raw, fromHeader, { to: [opts.to] });
}

// Strip a "Display Name <addr>" wrapper down to the bare address for the SMTP envelope.
function bareAddr(s: string): string {
	const m = s.match(/<([^>]+)>/);
	return (m ? m[1] : s).trim();
}

// Send raw MIME via the Cloudflare Email Sending binding (cloudflare:email).
// The legacy EmailMessage envelope is single-recipient, so we send one message
// per envelope recipient (to + cc + bcc) sharing the same raw body - this matches
// SES SendRawEmail's Destination semantics and keeps Bcc out of the visible headers
// (buildRawEmail never writes a Bcc header). Returns the last platform message id.
export async function sendRawViaBinding(
	env: Env,
	rawMessage: string,
	envelopeFrom: string,
	destination: { to?: string[]; cc?: string[]; bcc?: string[] },
): Promise<string> {
	const from = bareAddr(envelopeFrom);
	const recipients = [...(destination.to || []), ...(destination.cc || []), ...(destination.bcc || [])]
		.map(bareAddr)
		.filter(Boolean);
	if (recipients.length === 0) throw new Error("no envelope recipients");

	let lastId = "";
	for (const rcpt of recipients) {
		const msg = new EmailMessage(from, rcpt, rawMessage);
		const res = (await env.EMAIL.send(msg)) as { messageId?: string } | undefined;
		lastId = res?.messageId ?? lastId;
	}
	return lastId;
}

// LEGACY/FALLBACK: send raw email via AWS SES. Kept available in case we need to
// revert from the Cloudflare binding. No longer wired into the live send path.
// Optional explicit destination drives the envelope (and keeps Bcc out of headers).
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
		const messageId = await sendRawViaBinding(env, relay.rawEmail, relay.from, { to: [relay.to] });

		await env.DB.prepare(
			"UPDATE delivery_log SET status = 'success', attempts = ?, completed_at = ?, error = ? WHERE id = ?",
		).bind(relay.attempt + 1, Date.now(), `cf:${messageId}`, relay.logId).run();
		msg.ack();
	} catch (err: any) {
		await env.DB.prepare(
			"UPDATE delivery_log SET status = 'retrying', error = ?, attempts = ? WHERE id = ?",
		).bind(err.message || "SES error", relay.attempt + 1, relay.logId).run();

		const delaySec = Math.min(2 ** (relay.attempt + 1), 1200);
		msg.retry({ delaySeconds: delaySec });
	}
}
