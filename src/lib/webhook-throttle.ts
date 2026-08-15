/**
 * Two limits in front of the public receiver endpoint, doing different jobs.
 *
 * `HOOK_RATE_LIMIT` is a burst shed, keyed by receiver id, and like the other
 * two bindings in this codebase it counts PER COLOCATION and FAILS OPEN. That
 * makes it useless as a quota and fine as a throttle -- which is exactly why the
 * daily cap exists underneath it. A fail-open limiter in front of a table that
 * grows forever is not a bound on anything; it is a bound on how fast the table
 * grows in one datacentre while the limiter happens to be up.
 *
 * `daily_cap` is the bound. It counts rows this receiver actually stored in the
 * last 24 hours, in D1, where the answer cannot fail open, and refuses to store
 * another once the number is reached.
 *
 * Both answer 429 with a `Retry-After`, which is the one refusal in the status
 * table that SHOULD make a provider come back: we are the ones saying not now.
 */

import type { Env, WebhookReceiver } from "../types";

/** The daily cap's window. Rolling, not a calendar day -- no timezone to get wrong. */
export const CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** What we tell a provider to wait when the burst limiter is what said no. */
const BURST_RETRY_SECONDS = 60;

function tooMany(error: string, retryAfterSeconds: number): Response {
	return Response.json(
		{ error },
		{ status: 429, headers: { "Retry-After": String(Math.max(1, retryAfterSeconds)) } },
	);
}

/**
 * The burst shed. Returns false once this receiver's bucket is empty in this
 * colo; a missing binding or a limiter error returns true, because a throttle
 * that turns its own outage into an outage of the thing it protects is worse
 * than the abuse it prevents.
 */
export async function recordHookRequest(env: Env, receiverId: string): Promise<boolean> {
	if (!env.HOOK_RATE_LIMIT) return true;
	try {
		const { success } = await env.HOOK_RATE_LIMIT.limit({ key: `hook:${receiverId}` });
		return success;
	} catch (err) {
		console.error("hook rate limiter unavailable, failing open:", err);
		return true;
	}
}

/**
 * Has this receiver stored its allowance in the last `CAP_WINDOW_MS`?
 *
 * Every row counts, whatever its status. The cap bounds table growth, and a
 * flood of handshake-shaped probes or of garbage that fails verification grows
 * the table exactly as fast as a flood of real deliveries does -- a cap that
 * only counted the well-behaved traffic would be a cap on the one kind that was
 * never the problem.
 *
 * `Retry-After` is the time until the oldest row in the window ages out, which
 * is the earliest moment the answer could actually change. Only queried when the
 * receiver set a cap, so the common path pays nothing.
 */
export async function checkDailyCap(
	env: Env,
	receiver: WebhookReceiver,
	now: number,
): Promise<Response | null> {
	const cap = receiver.daily_cap;
	if (!cap || cap <= 0) return null;

	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS count, MIN(created_at) AS oldest
		FROM webhook_events
		WHERE receiver_id = ? AND created_at >= ?`,
	)
		.bind(receiver.id, now - CAP_WINDOW_MS)
		.first<{ count: number; oldest: number | null }>();

	const count = row?.count ?? 0;
	if (count < cap) return null;

	const oldest = row?.oldest ?? now;
	console.warn(
		`webhook daily cap reached for ${receiver.inbox}/${receiver.slug}: ${count}/${cap} in 24h`,
	);
	return tooMany("daily event cap reached", Math.ceil((oldest + CAP_WINDOW_MS - now) / 1000));
}

/**
 * The burst shed as a Response, for the call site. Runs before the body is read,
 * because shedding load after doing the work is not shedding load.
 */
export async function checkBurst(env: Env, receiver: WebhookReceiver): Promise<Response | null> {
	if (await recordHookRequest(env, receiver.id)) return null;
	console.warn(`webhook rate limit hit for ${receiver.inbox}/${receiver.slug}`);
	return tooMany("too many requests for this receiver", BURST_RETRY_SECONDS);
}
