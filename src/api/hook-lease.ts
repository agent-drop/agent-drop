/**
 * The consuming half of the queue -- `/api/hooks/queue/:box/{get,remove,return,extend,requeue}`.
 *
 * Everything here LEASES, MUTATES or DESTROYS, which is why none of it sits
 * beside the reads in `hook-queue.ts`: those are GETs under `keyedReader` and
 * this is POSTs under `keyedWriter`. A peek cannot consume a queue by accident;
 * a get is a deliberate act by a credential allowed to write.
 *
 * Two invariants run through every statement below.
 *
 * Every query filters by `inbox` as well as by id. The inbox came from the path
 * and was scope-checked by the gate, so an id on its own must never be enough to
 * reach -- let alone lease, ack or destroy -- another box's event.
 *
 * A `handshake` row is evidence, not a queue item. The lease SELECT excludes it
 * by only taking `queued` and expired-`leased` rows, and `requeue` excludes it
 * explicitly: there is no path by which "the provider says my URL failed
 * validation" turns into work an agent is handed.
 */

import { detail, resolveReceiverId } from "./hook-queue";
import type { Env, WebhookEvent } from "../types";

/** Default lease, and the ceiling on one. */
const DEFAULT_LEASE_SECONDS = 60;
const MAX_LEASE_SECONDS = 3600;
const MAX_BATCH = 200;

export interface LeaseBody {
	limit?: number;
	leaseSeconds?: number;
	receiver?: string;
	/** Ack at handout -- at-most-once, for a caller that wants no bookkeeping. */
	remove?: boolean;
}

export interface IdsBody {
	ids?: string[];
	leaseSeconds?: number;
	leaseId?: string;
}

function clamp(value: unknown, fallback: number, max: number): number {
	const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(n) || n < 1) return fallback;
	return Math.min(Math.trunc(n), max);
}

export async function readJson<T>(request: Request): Promise<T | null> {
	try {
		return (await request.json()) as T;
	} catch {
		return null;
	}
}

export function idsFrom(body: IdsBody | null): string[] | null {
	const ids = body?.ids;
	if (!Array.isArray(ids) || ids.length === 0) return null;
	return [...new Set(ids.map(String))].slice(0, MAX_BATCH);
}

function placeholders(ids: string[]): string {
	return ids.map(() => "?").join(", ");
}

/**
 * Hand out up to `limit` events, hidden from every other consumer until the lease
 * expires or the caller removes them.
 *
 * One statement, atomic under SQLite, because two consumers pulling at the same
 * moment must not both be handed the same message -- and a read-then-write pair
 * cannot promise that. The subselect is required: `UPDATE ... LIMIT` is not
 * compiled into SQLite by default. `RETURNING` gives us the rows we just claimed
 * without a second read that could see someone else's claim.
 *
 * An expired lease returns to the pool through the `OR` rather than through a
 * sweeper -- a crashed consumer's work becomes available again the moment its
 * deadline passes, with nothing scheduled to notice.
 */
export async function handleQueueGet(request: Request, env: Env, inbox: string): Promise<Response> {
	const body = (await readJson<LeaseBody>(request)) ?? {};
	const limit = clamp(body.limit, 10, MAX_BATCH);
	const leaseSeconds = clamp(body.leaseSeconds, DEFAULT_LEASE_SECONDS, MAX_LEASE_SECONDS);
	const now = Date.now();
	const leasedUntil = now + leaseSeconds * 1000;
	const leaseId = crypto.randomUUID();
	// Either form -- the id is what the API returns, the slug is what you remember
	// -- resolved to the id, so a rotation does not hide a receiver's older
	// messages from a consumer that pulls by name.
	const ref = body.receiver ?? null;
	const receiver = ref ? ((await resolveReceiverId(env, inbox, ref)) ?? ref) : null;

	const { results } = await env.DB.prepare(
		`UPDATE webhook_events
		    SET status = 'leased', lease_id = ?, leased_until = ?, lease_count = lease_count + 1
		  WHERE id IN (
		    SELECT id FROM webhook_events
		     WHERE inbox = ?
		       AND (status = 'queued' OR (status = 'leased' AND leased_until < ?))
		       AND (? IS NULL OR receiver_id = ? OR slug = ?)
		     ORDER BY created_at ASC, id ASC
		     LIMIT ?
		  )
		  RETURNING *`,
	)
		.bind(leaseId, leasedUntil, inbox, now, receiver, receiver, ref, limit)
		.all<WebhookEvent>();

	// `--ack` on pull collapses at-least-once to at-most-once. Done as a second
	// statement rather than a different lease, so the handout path stays one shape.
	if (body.remove && results.length) {
		const ids = results.map((r) => r.id);
		await env.DB.prepare(
			`UPDATE webhook_events SET status = 'acked', acked_at = ?, lease_id = NULL,
			   leased_until = NULL
			  WHERE inbox = ? AND id IN (${placeholders(ids)})`,
		)
			.bind(now, inbox, ...ids)
			.run();
	}

	// The same shape the read side hands back, so a pulled event and a peeked one
	// are the same object to a consumer.
	return Response.json({
		events: results.map(detail),
		count: results.length,
		lease_id: body.remove ? null : leaseId,
		leased_until: body.remove ? null : leasedUntil,
	});
}

interface StatusRow {
	id: string;
	status: WebhookEvent["status"];
}

async function loadStatuses(env: Env, inbox: string, ids: string[]): Promise<StatusRow[]> {
	const { results } = await env.DB.prepare(
		`SELECT id, status FROM webhook_events WHERE inbox = ? AND id IN (${placeholders(ids)})`,
	)
		.bind(inbox, ...ids)
		.all<StatusRow>();
	return results;
}

/**
 * The ack: off the queue, row kept.
 *
 * Idempotent by construction -- an id that is already `acked` is reported, not
 * re-stamped, so `acked_at` keeps saying when the work actually finished. A
 * consumer that crashes between acking and recording that it acked can simply
 * ack again.
 *
 * A `handshake` row is refused. Nothing ever leases one, so the only way to ack
 * one is to name it by id, and turning it into `acked` would erase the only
 * evidence of a failed provider validation with no way back -- `requeue` will
 * not take a handshake row either.
 */
export async function handleQueueRemove(
	request: Request,
	env: Env,
	inbox: string,
): Promise<Response> {
	const ids = idsFrom(await readJson<IdsBody>(request));
	if (!ids) return Response.json({ error: "ids required" }, { status: 400 });

	const rows = await loadStatuses(env, inbox, ids);
	const changed = rows.filter((r) => r.status !== "acked" && r.status !== "handshake");
	if (changed.length) {
		const now = Date.now();
		const targets = changed.map((r) => r.id);
		await env.DB.prepare(
			`UPDATE webhook_events SET status = 'acked', acked_at = ?, lease_id = NULL,
			   leased_until = NULL
			  WHERE inbox = ? AND id IN (${placeholders(targets)})`,
		)
			.bind(now, inbox, ...targets)
			.run();
	}

	return Response.json({
		removed: changed.length,
		already_removed: rows.filter((r) => r.status === "acked").length,
		skipped_handshake: rows.filter((r) => r.status === "handshake").length,
		missing: ids.length - rows.length,
	});
}

/** The nack: release a lease now instead of waiting it out. */
export async function handleQueueReturn(
	request: Request,
	env: Env,
	inbox: string,
): Promise<Response> {
	const ids = idsFrom(await readJson<IdsBody>(request));
	if (!ids) return Response.json({ error: "ids required" }, { status: 400 });

	const { meta } = await env.DB.prepare(
		`UPDATE webhook_events SET status = 'queued', lease_id = NULL, leased_until = NULL
		  WHERE inbox = ? AND status = 'leased' AND id IN (${placeholders(ids)})`,
	)
		.bind(inbox, ...ids)
		.run();

	return Response.json({ returned: meta.changes, requested: ids.length });
}

/**
 * Hold a lease longer, mid-work.
 *
 * Ownership does not change: `lease_id` is untouched and `lease_count` is not
 * bumped, because this is the same handout continuing rather than a new one. An
 * expired lease is NOT extended -- it is back in the pool and may already belong
 * to someone else, so extending it would be taking it back silently. Pass
 * `leaseId` to make the statement refuse to extend a lease that is not yours.
 */
export async function handleQueueExtend(
	request: Request,
	env: Env,
	inbox: string,
): Promise<Response> {
	const body = await readJson<IdsBody>(request);
	const ids = idsFrom(body);
	if (!ids) return Response.json({ error: "ids required" }, { status: 400 });

	const now = Date.now();
	const leasedUntil =
		now + clamp(body?.leaseSeconds, DEFAULT_LEASE_SECONDS, MAX_LEASE_SECONDS) * 1000;
	const leaseId = body?.leaseId ?? null;

	const { meta } = await env.DB.prepare(
		`UPDATE webhook_events SET leased_until = ?
		  WHERE inbox = ? AND status = 'leased' AND leased_until > ?
		    AND (? IS NULL OR lease_id = ?)
		    AND id IN (${placeholders(ids)})`,
	)
		.bind(leasedUntil, inbox, now, leaseId, leaseId, ...ids)
		.run();

	return Response.json({
		extended: meta.changes,
		requested: ids.length,
		leased_until: leasedUntil,
	});
}

/**
 * Back onto the queue: `acked` or `rejected` -> `queued`.
 *
 * `handshake` is deliberately not in that list. A handshake row is the evidence
 * that a provider's setup call arrived and what we answered; feeding one to an
 * agent as work would be a lie about what it is, and it is the one status with no
 * way back out.
 */
export async function handleQueueRequeue(
	request: Request,
	env: Env,
	inbox: string,
): Promise<Response> {
	const ids = idsFrom(await readJson<IdsBody>(request));
	if (!ids) return Response.json({ error: "ids required" }, { status: 400 });

	const { meta } = await env.DB.prepare(
		`UPDATE webhook_events
		    SET status = 'queued', acked_at = NULL, lease_id = NULL, leased_until = NULL
		  WHERE inbox = ? AND status IN ('acked', 'rejected')
		    AND id IN (${placeholders(ids)})`,
	)
		.bind(inbox, ...ids)
		.run();

	return Response.json({ requeued: meta.changes, requested: ids.length });
}
