import { EmailMessage } from "cloudflare:email";
import { AwsClient } from "aws4fetch";
import type { Env } from "../types";
import { toEmailAttachment } from "./email-builder";
import { generateId } from "./id";
import { bareAddr, buildRawEmail } from "./mime";

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
	return `${encoded.slice(0, idx)}@${encoded.slice(idx + 4)}`;
}

// Build relay reply-to address
// sender@example.com + mask j-7k9m -> sender_at_example.com+j-7k9m@{domain}
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
			if (maskId.startsWith(`${prefix}-`)) return rule;
		}
	}
	return null;
}

// Forward a received email to `to` via the Cloudflare Email Sending binding.
// message.forward() only delivers to CF-verified destinations; re-sending via the
// binding delivers to any address. The From is rewritten to the box address (so
// the zone's DKIM/SPF apply), with the original sender preserved in Reply-To.
//
// The original attachments ride along as bytes: the binding takes `content` as
// ArrayBuffer/ArrayBufferView/string directly, so nothing is base64-encoded on
// the way out. postal-mime's parsed attachments already have that shape.
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
		attachments?: {
			filename?: string;
			mimeType?: string;
			content: ArrayBuffer | ArrayBufferView | string;
			contentId?: string;
			disposition?: string;
		}[];
		messageId?: string | null;
	},
): Promise<string> {
	const boxAddr = `${opts.box}@${env.MAIL_DOMAIN}`;
	const label = (opts.fromName || opts.from || "").replace(/"/g, "");

	const attachments = (opts.attachments || []).map((a) =>
		toEmailAttachment({
			filename: a.filename || "attachment",
			contentType: a.mimeType || "application/octet-stream",
			content: a.content,
			inline: a.disposition === "inline" || !!a.contentId,
			cid: a.contentId,
		}),
	);

	const builder: EmailMessageBuilder = {
		from: { name: `${label} (via ${boxAddr})`, email: boxAddr },
		to: opts.to,
		subject: opts.subject || "(no subject)",
	};
	if (opts.from) builder.replyTo = opts.from;
	if (opts.textBody) builder.text = opts.textBody;
	if (opts.htmlBody) builder.html = opts.htmlBody;
	if (!builder.text && !builder.html) builder.text = "";
	if (attachments.length) builder.attachments = attachments;
	// The forwarded copy points back at the original so a client that has both
	// threads them together. In-Reply-To is deliberately not set: this is a
	// forward, not a reply.
	if (opts.messageId) builder.headers = { References: opts.messageId };

	const res = await env.EMAIL.send(builder);
	return res?.messageId ?? "";
}

// Send raw MIME through the legacy EmailMessage API, one envelope recipient at a
// time. Composed mail no longer comes through here -- it goes to the structured
// builder in api/send.ts, which takes the whole recipient list in one send. This
// path survives for the relay queue consumer, which replays a MIME string it
// stored at enqueue time and so has nothing structured left to hand the builder.
export async function sendRawViaBinding(
	env: Env,
	rawMessage: string,
	envelopeFrom: string,
	recipient: string,
): Promise<string> {
	const from = bareAddr(envelopeFrom);
	const to = bareAddr(recipient);
	if (!to) throw new Error("no envelope recipient");

	const msg = new EmailMessage(from, to, rawMessage);
	const res = (await env.EMAIL.send(msg)) as { messageId?: string } | undefined;
	return res?.messageId ?? "";
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

// Queue a relay email for delivery.
// The MIME is assembled here, at enqueue time, and replayed verbatim by the
// consumer -- a relay must reproduce the message it was handed, so the raw API
// is the right one for this path.
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
	)
		.bind(logId, opts.maskId, `relay:${opts.direction}`, opts.to, Date.now())
		.run();

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
export async function processRelayMessage(msg: Message<any>, env: Env): Promise<void> {
	const relay = msg.body;
	const MAX_AGE_MS = 24 * 60 * 60 * 1000;

	if (Date.now() - relay.firstAttemptAt > MAX_AGE_MS) {
		await env.DB.prepare(
			"UPDATE delivery_log SET status = 'failed', error = 'exceeded 24h retry window', completed_at = ? WHERE id = ?",
		)
			.bind(Date.now(), relay.logId)
			.run();
		msg.ack();
		return;
	}

	try {
		const messageId = await sendRawViaBinding(env, relay.rawEmail, relay.from, relay.to);

		await env.DB.prepare(
			"UPDATE delivery_log SET status = 'success', attempts = ?, completed_at = ?, error = ? WHERE id = ?",
		)
			.bind(relay.attempt + 1, Date.now(), `cf:${messageId}`, relay.logId)
			.run();
		msg.ack();
	} catch (err: any) {
		await env.DB.prepare(
			"UPDATE delivery_log SET status = 'retrying', error = ?, attempts = ? WHERE id = ?",
		)
			.bind(err.message || "SES error", relay.attempt + 1, relay.logId)
			.run();

		const delaySec = Math.min(2 ** (relay.attempt + 1), 1200);
		msg.retry({ delaySeconds: delaySec });
	}
}
