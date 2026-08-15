import type { Env } from "../types";
import { resolveObjectKey } from "./drops";
import { type EventReapSummary, reapExpiredEvents } from "./hook-reaper";

/**
 * Reaper for drops stuck in `pending`.
 *
 * A presigned upload writes its drop row BEFORE the client has uploaded
 * anything, so every presign that is never used leaves a `pending` row behind
 * forever. R2 event notifications (src/lib/r2-events.ts) close the case where
 * the bytes DID land; this closes the case where they never did, plus the
 * residue of any notification that was lost.
 *
 * Two outcomes, decided by asking R2 rather than by guessing:
 *
 * - object present -> the upload landed and nothing completed it. COMPLETE it.
 *   The PLAN only called for deletion, but destroying a drop whose bytes are
 *   sitting in the bucket would be data loss dressed up as cleanup.
 * - object absent  -> the presign was never spent. DELETE the row.
 *
 * Nothing is deleted from R2: in the delete branch there is, by definition,
 * nothing there.
 */

/** How long a drop may sit `pending` before the reaper looks at it. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Ceiling on rows touched per run, so one invocation cannot run away. */
export const REAP_BATCH = 500;

export interface ReapSummary {
	scanned: number;
	completed: number;
	deleted: number;
	/** Rows too old to complete and with no key to check -- left alone. */
	skipped: number;
}

interface StaleRow {
	id: string;
	inbox: string;
	r2_prefix: string | null;
	object_key: string | null;
	subject: string | null;
	status: string;
}

/**
 * Find `pending` drops older than `STALE_AFTER_MS` and resolve each one.
 * `now` is injectable so the selection policy is testable without sleeping.
 */
export async function reapPendingDrops(env: Env, now: number = Date.now()): Promise<ReapSummary> {
	const cutoff = now - STALE_AFTER_MS;

	const { results } = await env.DB.prepare(
		`SELECT id, inbox, r2_prefix, object_key, subject, status
		FROM drops
		WHERE status = 'pending' AND created_at < ?
		ORDER BY created_at ASC
		LIMIT ?`,
	)
		.bind(cutoff, REAP_BATCH)
		.all<StaleRow>();

	const summary: ReapSummary = {
		scanned: results.length,
		completed: 0,
		deleted: 0,
		skipped: 0,
	};

	for (const row of results) {
		const key = resolveObjectKey(row);
		if (!key) {
			// No recorded key and not enough to rebuild one. Deleting on a guess is
			// worse than leaving one row behind; it gets logged instead.
			summary.skipped++;
			continue;
		}

		const object = await env.BUCKET.head(key);
		if (object) {
			await env.DB.prepare(
				"UPDATE drops SET status = 'completed' WHERE id = ? AND status = 'pending'",
			)
				.bind(row.id)
				.run();
			summary.completed++;
		} else {
			await env.DB.prepare("DELETE FROM drops WHERE id = ? AND status = 'pending'")
				.bind(row.id)
				.run();
			summary.deleted++;
		}
	}

	return summary;
}

/** The stale-`pending` sweep plus its log line. */
export async function runScheduled(env: Env, now: number = Date.now()): Promise<ReapSummary> {
	const summary = await reapPendingDrops(env, now);
	if (summary.scanned) {
		console.log(
			`reaper: scanned ${summary.scanned} stale pending drops -- ` +
				`completed ${summary.completed}, deleted ${summary.deleted}, skipped ${summary.skipped}`,
		);
	}
	return summary;
}

export interface SweepSummary {
	/** Null when that sweep threw; the error is logged, the other still ran. */
	drops: ReapSummary | null;
	events: EventReapSummary | null;
}

/**
 * Everything the hourly cron does, kept out of src/index.ts so it is testable.
 *
 * Two sweeps that share nothing: stale `pending` drops, and webhook events past
 * their retention. They run independently and are settled rather than chained,
 * because a D1 or R2 hiccup in one is no reason to skip the other -- the failure
 * mode that buys is a bucket that quietly stops expiring because an unrelated
 * upload check threw.
 */
export async function runSweeps(env: Env, now: number = Date.now()): Promise<SweepSummary> {
	const [drops, events] = await Promise.allSettled([
		runScheduled(env, now),
		reapExpiredEvents(env, now),
	]);

	if (drops.status === "rejected")
		console.error("reaper: pending-drop sweep failed:", drops.reason);
	if (events.status === "rejected") {
		console.error("reaper: webhook-event sweep failed:", events.reason);
	} else if (events.value.scanned) {
		console.log(
			`hook reaper: scanned ${events.value.scanned} expired events -- ` +
				`deleted ${events.value.deleted}, bodies ${events.value.bodies}, kept ${events.value.kept}`,
		);
	}

	return {
		drops: drops.status === "fulfilled" ? drops.value : null,
		events: events.status === "fulfilled" ? events.value : null,
	};
}
