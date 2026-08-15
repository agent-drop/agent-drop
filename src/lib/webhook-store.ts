/**
 * Writing a received request down without changing it.
 *
 * The one guarantee this module exists to keep: what a consumer reads back is
 * byte-for-byte what the provider sent. The bytes are hashed before anything
 * decodes them, the text form is only ever a convenience copy of a body that was
 * already valid UTF-8, and nothing here re-serializes a parsed body. Signing a
 * re-serialized JSON object is the classic way to ship a verifier that rejects
 * every real request -- key order, whitespace and unicode escaping all shift,
 * and once the re-serialized form is what you stored, the evidence is gone.
 */

import { generateId } from "./id";
import type { Extracted } from "./webhook-extract";
import type { Env, WebhookEvent, WebhookReceiver } from "../types";

/** Bodies at or under this store inline in D1; larger ones go to R2. */
export const INLINE_BODY_LIMIT = 64 * 1024;

const REDACTED = "<redacted>";

/**
 * Headers that are credentials in their own right. Everything else is stored
 * verbatim -- including signature headers, deliberately. An allowlist cannot
 * work (the signature is `sign` for one provider, `X-Hub-Signature-256` for the
 * next, and whatever the one after that invents), and an HMAC or digest proves
 * one specific body came from the signer -- it is worthless against any other
 * request. Redacting it would only make consumer-side verification impossible,
 * which is the single thing a faithful receiver exists to enable.
 */
const ALWAYS_REDACT = new Set(["authorization", "cookie", "proxy-authorization"]);

/**
 * The complete header map, with true credentials replaced. `extraRedact` carries
 * whatever this receiver's own auth_config names as a shared secret -- a
 * `header`-mode receiver's token is a credential even though its name is not on
 * the fixed list.
 */
export function collectHeaders(
	headers: Headers,
	extraRedact: string[] = [],
): Record<string, string> {
	const extra = new Set(extraRedact.map((h) => h.toLowerCase()));
	const out: Record<string, string> = {};
	for (const [name, value] of headers) {
		const key = name.toLowerCase();
		out[key] = ALWAYS_REDACT.has(key) || extra.has(key) ? REDACTED : value;
	}
	return out;
}

/**
 * The query string, with whatever this receiver's config names as a secret
 * replaced. Same treatment as the headers, for the same reason: a shared secret
 * that arrives in a `?token=` is still a shared secret.
 */
export function collectQuery(url: URL, extraRedact: string[] = []): Record<string, string> {
	const redact = new Set(extraRedact);
	const out: Record<string, string> = {};
	for (const [key, value] of url.searchParams) out[key] = redact.has(key) ? REDACTED : value;
	return out;
}

/**
 * Has this receiver already stored this event? Only asked when the extractor
 * produced a dedupe key. For a provider message id the unique index is the real
 * enforcement and this is just the cheap path; for a bucketed body hash the
 * alternates matter, because a retry landing a second past a bucket boundary
 * would otherwise be a fresh key.
 */
export async function findDuplicate(
	env: Env,
	receiverId: string,
	extracted: Extracted,
	now: number,
): Promise<string | null> {
	if (!extracted.dedupeKey) return null;
	const keys = [extracted.dedupeKey, ...extracted.dedupeAlternates];
	const since = extracted.dedupeWindowMs ? now - extracted.dedupeWindowMs : 0;
	const row = await env.DB.prepare(
		`SELECT id FROM webhook_events
		  WHERE receiver_id = ? AND created_at >= ?
		    AND dedupe_key IN (${keys.map(() => "?").join(", ")})
		  LIMIT 1`,
	)
		.bind(receiverId, since, ...keys)
		.first<{ id: string }>();
	return row?.id ?? null;
}

export interface StoreInput {
	receiver: WebhookReceiver;
	method: string;
	subpath: string | null;
	headers: Record<string, string>;
	query: Record<string, string>;
	contentType: string | null;
	/** The raw bytes, exactly as they arrived. */
	bytes: Uint8Array;
	/** The decoded body -- present only when the bytes were valid UTF-8. */
	text: string | null;
	sha256: string;
	extracted: Extracted;
	verified: number | null;
	status: WebhookEvent["status"];
	remoteIp: string | null;
	country: string | null;
	userAgent: string | null;
	now: number;
}

/** A rejected event is debugging evidence for a rotated secret, not an archive. */
const REJECTED_RETENTION_DAYS = 7;
const DAY_MS = 86_400_000;

export function retentionFor(receiver: WebhookReceiver, status: WebhookEvent["status"]): number {
	if (status === "rejected") return REJECTED_RETENTION_DAYS;
	return receiver.retention_days ?? 120;
}

export function bodyKeyFor(receiver: WebhookReceiver, id: string): string {
	return `hooks/${receiver.inbox}/${receiver.slug}/${id}`;
}

/**
 * Persist one event. Returns the new id, or the id of the event it duplicates.
 *
 * The R2 body is written before the row so a completed row never points at a
 * missing object; if the insert then loses a dedupe race, the object is cleaned
 * up rather than orphaned.
 */
export async function storeEvent(
	env: Env,
	input: StoreInput,
): Promise<{ id: string; duplicate: false } | { id: string; duplicate: true }> {
	// A dedupe key describes an event that ENTERED THE QUEUE. A refusal did not:
	// it is evidence kept for 7 days (§9), not a queue member, so it neither
	// dedupes against a real event nor blocks one. Both directions matter.
	//
	// Blocking one is the expensive half: wrong secret -> 401, stored `rejected`
	// -> operator fixes the secret -> the provider retries the same bytes -> we
	// answer `200 {"duplicate":true}` and store nothing. The provider stops, and
	// the only row left is one no lease will ever hand out. We told the sender we
	// had an event we had thrown away. (The unique index enforces the same thing
	// one layer down, so carrying the key on a rejected row would turn that retry
	// into a 503 rather than a lost event -- still wrong, just louder.)
	//
	// The other direction: a refusal must answer 401 even when an accepted copy is
	// already stored. Deduping it would 200 a request we did not accept.
	const dedupes = input.status !== "rejected";
	const dedupeKey = dedupes ? input.extracted.dedupeKey : null;

	const existing = dedupes
		? await findDuplicate(env, input.receiver.id, input.extracted, input.now)
		: null;
	if (existing) return { id: existing, duplicate: true };

	const id = generateId();
	const inline = input.text !== null && input.bytes.byteLength <= INLINE_BODY_LIMIT;
	const bodyKey = inline ? null : bodyKeyFor(input.receiver, id);

	if (bodyKey) {
		await env.BUCKET.put(bodyKey, input.bytes, {
			httpMetadata: { contentType: input.contentType || "application/octet-stream" },
		});
	}

	const expiresAt = input.now + retentionFor(input.receiver, input.status) * DAY_MS;

	try {
		await env.DB.prepare(
			`INSERT INTO webhook_events (
				id, receiver_id, inbox, slug, subpath, method, event_type, routing_key, dedupe_key,
				headers, query, content_type, body_text, body_r2_key, body_bytes, body_sha256,
				verified, remote_ip, country, user_agent, status, created_at, expires_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				id,
				input.receiver.id,
				input.receiver.inbox,
				input.receiver.slug,
				input.subpath,
				input.method,
				input.extracted.eventType,
				input.extracted.routingKey,
				dedupeKey,
				JSON.stringify(input.headers),
				JSON.stringify(input.query),
				input.contentType,
				inline ? input.text : null,
				bodyKey,
				input.bytes.byteLength,
				input.sha256,
				input.verified,
				input.remoteIp,
				input.country,
				input.userAgent,
				input.status,
				input.now,
				expiresAt,
			)
			.run();
	} catch (err) {
		if (bodyKey) await env.BUCKET.delete(bodyKey).catch(() => {});
		// Lost a race against a concurrent copy of the same delivery. The other one
		// stored; this one is the duplicate.
		const raced = dedupes
			? await findDuplicate(env, input.receiver.id, input.extracted, input.now)
			: null;
		if (raced) return { id: raced, duplicate: true };
		throw err;
	}

	return { id, duplicate: false };
}

/** Counters are cosmetic, so they ride `waitUntil` rather than the response. */
export async function bumpReceiverCounters(env: Env, receiverId: string, now: number) {
	await env.DB.prepare(
		"UPDATE webhook_receivers SET event_count = event_count + 1, last_event_at = ? WHERE id = ?",
	)
		.bind(now, receiverId)
		.run();
}
