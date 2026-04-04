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

// Build a raw MIME email for SES SendRawEmail
export function buildRawEmail(opts: {
	from: string;
	to: string;
	replyTo?: string;
	subject: string;
	textBody?: string;
	htmlBody?: string;
	inReplyTo?: string;
	references?: string;
}): string {
	const messageId = `<${crypto.randomUUID()}@example.com>`;
	const boundary = `----=_Part_${crypto.randomUUID()}`;
	const date = new Date().toUTCString();

	const headers = [
		`From: ${opts.from}`,
		`To: ${opts.to}`,
		opts.replyTo ? `Reply-To: ${opts.replyTo}` : null,
		`Subject: ${opts.subject}`,
		`Date: ${date}`,
		`Message-ID: ${messageId}`,
		opts.inReplyTo ? `In-Reply-To: ${opts.inReplyTo}` : null,
		opts.references ? `References: ${opts.references}` : null,
		`MIME-Version: 1.0`,
	].filter(Boolean);

	if (opts.htmlBody && opts.textBody) {
		headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
		return [
			...headers,
			"",
			`--${boundary}`,
			"Content-Type: text/plain; charset=UTF-8",
			"Content-Transfer-Encoding: quoted-printable",
			"",
			opts.textBody,
			`--${boundary}`,
			"Content-Type: text/html; charset=UTF-8",
			"Content-Transfer-Encoding: quoted-printable",
			"",
			opts.htmlBody,
			`--${boundary}--`,
		].join("\r\n");
	}

	headers.push("Content-Type: text/plain; charset=UTF-8");
	return [...headers, "", opts.textBody || ""].join("\r\n");
}

// Send raw email via SES
export async function sendRawEmail(env: Env, rawMessage: string): Promise<string> {
	const ses = new AwsClient({
		accessKeyId: env.AWS_ACCESS_KEY_ID,
		secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
		region: env.SES_REGION,
		service: "ses",
	});

	const encoded = btoa(unescape(encodeURIComponent(rawMessage)));

	const res = await ses.fetch(
		`https://email.${env.SES_REGION}.amazonaws.com/v2/email/outbound-emails`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				Content: {
					Raw: { Data: encoded },
				},
			}),
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
