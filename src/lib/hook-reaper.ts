/**
 * Retention for received webhook events.
 *
 * Every event is stamped with an `expires_at` at INSERT time, from the
 * receiver's `retention_days` (120 by default) or the hardcoded 7 days a
 * `rejected` row gets -- see `retentionFor` in webhook-store.ts. Stamping it at
 * insert rather than computing it at read is the point: raising a receiver's
 * retention must not resurrect what has already aged out, and lowering it must
 * not retroactively destroy history somebody was promised.
 *
 * So this sweep asks one question -- has this row passed the date it was given?
 * -- and never recomputes the answer from the receiver's current setting.
 *
 * Bodies before rows, always. An orphaned R2 object is invisible and bills
 * forever; a surviving row whose body is gone is a 410 to a consumer that had
 * every reason to expect bytes. When a body will not delete, its row is left
 * behind on purpose so the next tick tries again.
 */

import type { Env } from "../types";

/** Ceiling on events destroyed per run, so one tick cannot run away. */
export const HOOK_REAP_BATCH = 500;

/**
 * Ids per DELETE. D1 caps bound parameters per query far below the 500 a full
 * batch could produce, so the deletes are chunked well under any of its limits.
 */
const DELETE_CHUNK = 50;

export interface EventReapSummary {
	/** Rows past `expires_at` this run looked at. */
	scanned: number;
	/** Rows destroyed. */
	deleted: number;
	/** R2 bodies destroyed (rows with an inline body have none). */
	bodies: number;
	/** Rows kept because their body would not delete -- retried next tick. */
	kept: number;
}

interface ExpiredRow {
	id: string;
	body_r2_key: string | null;
}

/**
 * Destroy events past their `expires_at`, oldest first.
 *
 * `now` is injectable so the boundary is testable without sleeping. It is
 * exclusive: a row expiring exactly now has not expired yet, matching the
 * pending-drop sweep next door.
 */
export async function reapExpiredEvents(
	env: Env,
	now: number = Date.now(),
): Promise<EventReapSummary> {
	const { results } = await env.DB.prepare(
		`SELECT id, body_r2_key
		FROM webhook_events
		WHERE expires_at < ?
		ORDER BY expires_at ASC
		LIMIT ?`,
	)
		.bind(now, HOOK_REAP_BATCH)
		.all<ExpiredRow>();

	const summary: EventReapSummary = { scanned: results.length, deleted: 0, bodies: 0, kept: 0 };
	const destroyable: string[] = [];

	for (const row of results) {
		if (row.body_r2_key) {
			try {
				await env.BUCKET.delete(row.body_r2_key);
				summary.bodies++;
			} catch (err) {
				// The row is the only record of which object belonged to it. Dropping it
				// now would strand those bytes in the bucket with nothing left pointing
				// at them, so the row stays and the next run has another go.
				console.error(`hook reaper: ${row.body_r2_key} not destroyed, keeping its row:`, err);
				summary.kept++;
				continue;
			}
		}
		destroyable.push(row.id);
	}

	for (let i = 0; i < destroyable.length; i += DELETE_CHUNK) {
		const chunk = destroyable.slice(i, i + DELETE_CHUNK);
		const result = await env.DB.prepare(
			`DELETE FROM webhook_events WHERE id IN (${chunk.map(() => "?").join(", ")})`,
		)
			.bind(...chunk)
			.run();
		summary.deleted += result.meta.changes;
	}

	return summary;
}
