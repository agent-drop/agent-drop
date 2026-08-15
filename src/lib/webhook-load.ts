/**
 * Reading a stored body back, wherever it went.
 *
 * A body is inline in D1 when it was valid UTF-8 and small, and in R2 when it
 * was neither -- and that fork is the one thing every consumer of a stored event
 * has to get right. `queue-body` streams it to a caller, `payload_mode:
 * passthrough` re-sends it to a target, `hook-replay` hands it to both. One
 * reader, so the byte-fidelity promise is kept in one place rather than
 * re-derived three times.
 */

import type { Env, WebhookEvent } from "../types";

export type StoredBody =
	/** The bytes, exactly as they arrived. */
	| { kind: "bytes"; bytes: Uint8Array }
	/** Nothing was recorded -- a request that carried no body at all. */
	| { kind: "empty" }
	/** The row says R2, R2 says no. Past its lifecycle rule, or purged. */
	| { kind: "gone" };

type BodyColumns = Pick<WebhookEvent, "body_text" | "body_r2_key">;

export async function loadStoredBody(env: Env, row: BodyColumns): Promise<StoredBody> {
	if (row.body_r2_key) {
		const object = await env.BUCKET.get(row.body_r2_key);
		if (!object) return { kind: "gone" };
		return { kind: "bytes", bytes: new Uint8Array(await object.arrayBuffer()) };
	}
	if (row.body_text === null || row.body_text === undefined) return { kind: "empty" };
	return { kind: "bytes", bytes: new TextEncoder().encode(row.body_text) };
}
