import { EmailMessage } from "cloudflare:email";
import { AwsClient } from "aws4fetch";
import type { Address } from "postal-mime";
import type { Env, RelayQueueMessage } from "../types";
import { hasHeaderControl, toEmailAttachment } from "./email-builder";
import { generateId } from "./id";
import type { SenderAuthResults } from "./mail-auth";
import { bareAddr, buildRawEmail, formatMailbox, sanitizeDisplayName } from "./mime";

const RELAY_TOKEN_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const RELAY_TOKEN_CHARS = 26;
const RELAY_TOKEN_PATTERN = /^reply\+([0-9a-hjkmnp-tv-z]{26})$/;

export interface RelayReplyRoute {
	sender: string;
	maskId: string;
}

function randomRelayToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(RELAY_TOKEN_CHARS));
	return Array.from(bytes, (byte) => RELAY_TOKEN_ALPHABET[byte & 31]).join("");
}

async function relayTokenHash(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

// Legacy transition only: encode a sender into the old forgeable address.
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

// Build a pre-token relay reply-to address for bounded migration support.
// sender@example.com + mask j-7k9m -> sender_at_example.com+j-7k9m@{domain}
export function buildLegacyRelayAddress(
	senderEmail: string,
	maskId: string,
	domain: string,
): string {
	return `${encodeEmail(senderEmail)}+${maskId}@${domain}`;
}

// Parse a pre-token relay reply address from the local part.
// sender_at_example.com+j-7k9m -> { sender: "sender@example.com", maskId: "j-7k9m" }
export function parseLegacyRelayAddress(localPart: string): RelayReplyRoute | null {
	const plusIdx = localPart.lastIndexOf("+");
	if (plusIdx < 0) return null;
	const encoded = localPart.slice(0, plusIdx);
	const maskId = localPart.slice(plusIdx + 1);
	if (!encoded.includes("_at_") || !maskId) return null;
	return { sender: decodeEmail(encoded), maskId };
}

export function parseRelayToken(localPart: string): string | null {
	return localPart.match(RELAY_TOKEN_PATTERN)?.[1] ?? null;
}

export function isLegacyRelayReply(localPart: string): boolean {
	return localPart.includes("_at_") && localPart.includes("+");
}

// Recognize both current opaque routes and deliberately transitional legacy
// addresses. Resolution decides whether the legacy cutoff still permits one.
export function isRelayReply(localPart: string): boolean {
	return parseRelayToken(localPart) !== null || isLegacyRelayReply(localPart);
}

export function legacyRelayRepliesEnabled(env: Env, now = Date.now()): boolean {
	const configured = env.RELAY_LEGACY_REPLY_UNTIL?.trim();
	if (!configured) return false;
	const cutoff = Date.parse(configured);
	return Number.isFinite(cutoff) && now < cutoff;
}

/**
 * Create a reusable opaque reply address and persist only its digest.
 *
 * The 130-bit token keeps the local part at 32 characters regardless of the
 * original sender's address length. Routes intentionally do not expire: an old
 * email thread must remain replyable until its mask is disabled or deleted.
 */
export async function createRelayAddress(
	env: Env,
	sender: string,
	maskId: string,
): Promise<string> {
	const token = randomRelayToken();
	await env.DB.prepare(
		"INSERT INTO relay_reply_routes (token_hash, mask_id, sender, created_at) VALUES (?, ?, ?, ?)",
	)
		.bind(await relayTokenHash(token), maskId, sender, Date.now())
		.run();
	return `reply+${token}@${env.MAIL_DOMAIN}`;
}

/** Resolve an opaque route, or a legacy sender-bearing route during its cutoff. */
export async function resolveRelayAddress(
	env: Env,
	localPart: string,
): Promise<RelayReplyRoute | null> {
	const token = parseRelayToken(localPart);
	if (token) {
		return env.DB.prepare(
			`SELECT route.sender AS sender, route.mask_id AS maskId
			 FROM relay_reply_routes AS route
			 JOIN email_masks AS mask ON mask.id = route.mask_id AND mask.active = 1
			 WHERE route.token_hash = ?`,
		)
			.bind(await relayTokenHash(token))
			.first<RelayReplyRoute>();
	}

	if (!legacyRelayRepliesEnabled(env)) return null;
	const legacy = parseLegacyRelayAddress(localPart);
	if (!legacy) return null;
	const mask = await env.DB.prepare("SELECT id FROM email_masks WHERE id = ? AND active = 1")
		.bind(legacy.maskId)
		.first();
	return mask ? legacy : null;
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

/** Two bare addresses name the same mailbox, compared case-insensitively. */
function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
	return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Why a reply through a mask may NOT go out as the mask, or null when it may.
 * `owner` is the mask's relay rule target, the only mailbox allowed to reply: a
 * reply route is an address, and addresses leak, so holding one proves nothing.
 *
 * A From header naming the owner is accepted unless Cloudflare's DMARC verdict
 * is an explicit `fail` (a forged From). A DMARC pass is not required, because
 * the owner's domain may publish no record. An envelope naming the owner covers
 * a provider alias whose From differs; but the envelope is the sender's to write
 * and DMARC judges the From domain, not the envelope's, so the envelope counts
 * only with Cloudflare's SPF pass for that very envelope.
 *
 * `auth` must be Cloudflare's own field (`firstSenderAuth`), never a later one.
 */
export function relayReplyRefusal(opts: {
	owner: string;
	headerFrom: string | undefined;
	envelope: string;
	auth: SenderAuthResults | null;
}): string | null {
	const owner = bareAddr(opts.owner);
	const byHeader = sameAddress(opts.headerFrom, owner);
	if (!byHeader && !sameAddress(opts.envelope, owner)) return "sender is not the mask owner";
	if (opts.auth?.dmarc.some((entry) => entry.result === "fail")) {
		return "dmarc=fail for the From header";
	}
	if (byHeader) return null;
	const spfPass = opts.auth?.spf.some(
		(entry) => entry.result === "pass" && sameAddress(entry.props["smtp.mailfrom"], opts.envelope),
	);
	return spfPass ? null : "owner envelope without an SPF pass for it";
}

// One `@` with something either side, and nothing that could reshape a header or
// smuggle in a second recipient: no whitespace, no `<>`, no list or quoting
// specials. Control characters are checked separately by hasHeaderControl.
const BARE_ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+$/;

function isBareAddress(value: string | undefined): value is string {
	return !!value && BARE_ADDRESS.test(value) && !hasHeaderControl(value);
}

/**
 * The first well-formed bare address among `sources`, read in order, else the
 * SMTP `envelope` sender. Group members count as addresses of their own.
 *
 * The envelope of most bulk and transactional mail is a bounce address, not a
 * person, so the relay reads postal-mime's parsed headers first: Reply-To then
 * From for where a reply goes, as a mail client would; From alone for who wrote.
 */
export function pickSenderAddress(
	sources: (Address | Address[] | undefined)[],
	envelope: string,
): string {
	for (const source of sources) {
		const entries = Array.isArray(source) ? source : source ? [source] : [];
		for (const entry of entries) {
			for (const mailbox of entry.group ?? [entry]) {
				if (isBareAddress(mailbox.address)) return mailbox.address;
			}
		}
	}
	return envelope;
}

// A sender label longer than this is cut. The name is the sender's to choose,
// and formatMailbox writes an ASCII name as one quoted-string on one line, so an
// unbounded one could push the From line past the 998-octet limit and get the
// whole message refused.
const SENDER_LABEL_MAX = 64;

/**
 * The display name forwarded and relayed mail carries: `<sender> (via <ours>)`,
 * where the sender is the From header's name, or the address when there is none.
 * Both paths call this, so they cannot label a sender two different ways.
 *
 * `repliesTo` is where a reply will actually go. When it is not the sender's
 * address the label says so, `<sender> (via <ours>, replies go to <address>)`:
 * the owner of a mask only ever sees the opaque route, so a Reply-To pointing
 * at a third party would otherwise redirect their answer unseen.
 *
 * The sender half and `repliesTo` are attacker-controlled and arrive already
 * RFC 2047-decoded, so both are sanitized and capped here. `via` is our own
 * address, never input.
 */
export function viaDisplayName(
	sender: { name?: string | null; address?: string | null },
	via: string,
	repliesTo?: string | null,
): string {
	const who = sanitizeDisplayName(sender.name || "") || sanitizeDisplayName(sender.address || "");
	const label = Array.from(who).slice(0, SENDER_LABEL_MAX).join("").trim();
	let tail = `via ${via}`;
	if (repliesTo && !sameAddress(repliesTo, sender.address)) {
		// Cut from the front: the domain is what decides who receives the reply.
		const target = Array.from(sanitizeDisplayName(repliesTo));
		const shown =
			target.length > SENDER_LABEL_MAX
				? `...${target.slice(3 - SENDER_LABEL_MAX).join("")}`
				: target.join("");
		if (shown) tail += `, replies go to ${shown}`;
	}
	return label ? `${label} (${tail})` : `(${tail})`;
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
		from: {
			name: viaDisplayName({ name: opts.fromName, address: opts.from }, boxAddr),
			email: boxAddr,
		},
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
//
// `from` stays a bare address all the way to the queue, because the consumer
// sends it as the envelope sender. `fromName` only decorates the From header.
export async function enqueueRelay(
	env: Env,
	opts: {
		maskId: string;
		direction: "inbound" | "reply";
		from: string;
		fromName?: string;
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
	const rawEmail = buildRawEmail({
		...opts,
		from: opts.fromName ? formatMailbox(opts.fromName, opts.from) : opts.from,
	});

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

export const RELAY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const RELAY_MAX_BACKOFF_SECONDS = 1200;

function relayAttemptOf(msg: { attempts?: number }): number {
	return msg.attempts && msg.attempts > 0 ? msg.attempts : 1;
}

export function relayBackoffFor(attempt: number): number {
	return Math.min(2 ** attempt, RELAY_MAX_BACKOFF_SECONDS);
}

// Process a relay message from the queue. Queue retry() re-enqueues the body
// unchanged, so the platform's Message.attempts is the only counter that grows.
export async function processRelayMessage(
	msg: Message<RelayQueueMessage>,
	env: Env,
): Promise<void> {
	const relay = msg.body;
	const attempt = relayAttemptOf(msg);

	if (Date.now() - relay.firstAttemptAt > RELAY_MAX_AGE_MS) {
		await env.DB.prepare(
			"UPDATE delivery_log SET status = 'failed', error = 'exceeded 24h retry window', attempts = ?, completed_at = ? WHERE id = ?",
		)
			.bind(attempt, Date.now(), relay.logId)
			.run();
		msg.ack();
		return;
	}

	try {
		const messageId = await sendRawViaBinding(env, relay.rawEmail, relay.from, relay.to);

		await env.DB.prepare(
			"UPDATE delivery_log SET status = 'success', attempts = ?, completed_at = ?, error = ? WHERE id = ?",
		)
			.bind(attempt, Date.now(), `cf:${messageId}`, relay.logId)
			.run();
		msg.ack();
	} catch (err: any) {
		await env.DB.prepare(
			"UPDATE delivery_log SET status = 'retrying', error = ?, attempts = ? WHERE id = ?",
		)
			.bind(err.message || "email delivery error", attempt, relay.logId)
			.run();

		msg.retry({ delaySeconds: relayBackoffFor(attempt) });
	}
}
