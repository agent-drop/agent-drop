/**
 * Injecting into the queue, destroying from it, and counting what is in it --
 * `/api/hooks/queue/:box/{put,delete,stats}` plus `DELETE .../:box/:id`.
 *
 * `remove` and `delete` are different verbs on purpose. Remove tombstones: the
 * row stays, readable and replayable until it expires, which is what "I processed
 * this" means. Delete destroys, R2 body included, which is what you want for a
 * junk ping or a misconfigured provider's noise -- and destroying something you
 * never processed should not require pretending to process it first.
 */

import { HOOK_PREFIX } from "../lib/webhook-defs";
import { type ReceiveOutcome, serveWebhook } from "../lib/webhook-receive";
import { idsFrom, type IdsBody, readJson } from "./hook-lease";
import type { Env, WebhookReceiver } from "../types";

interface PutBody {
	receiver?: string;
	method?: string;
	subpath?: string;
	headers?: Record<string, string>;
	query?: Record<string, string>;
	body?: string;
	bodyBase64?: string;
	contentType?: string;
}

interface DeleteBody extends IdsBody {
	/** Everything already removed (acked). */
	removed?: boolean;
	/** Everything that arrived before this id -- an arrival cursor, not a date. */
	before?: string;
}

function bad(error: string, status = 400): Response {
	return Response.json({ error }, { status });
}

function placeholders(ids: string[]): string {
	return ids.map(() => "?").join(", ");
}

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * Inject a message as if the provider had sent it.
 *
 * Deliberately the SAME code path: the request is assembled and handed to
 * `serveWebhook`, so it goes through method and size checks, handshake detection,
 * verification, extraction, both redaction lists and the dedupe index exactly as a
 * real delivery does. A second, friendlier path that skipped any of that would
 * make this useless for the thing it exists for -- reproducing a provider's
 * payload from a saved body and finding out what actually happens to it.
 *
 * Which means an injected request into a receiver that verifies signatures is
 * rejected unless it carries a valid one, and is stored `rejected` when it does
 * not. That is the honest answer, not a bug: there is no flag here that writes
 * `verified = 1` for a signature nothing checked.
 */
export async function handleQueuePut(
	request: Request,
	env: Env,
	inbox: string,
	ctx: ExecutionContext,
): Promise<Response> {
	const body = await readJson<PutBody>(request);
	if (!body) return bad("invalid JSON body");
	if (!body.receiver) return bad("receiver required (its id or slug)");

	// Resolved inside the gate's inbox: a receiver id alone must not reach another
	// box's receiver any more than an event id may reach its events.
	const receiver = await env.DB.prepare(
		"SELECT * FROM webhook_receivers WHERE inbox = ? AND (id = ? OR slug = ?) LIMIT 1",
	)
		.bind(inbox, body.receiver, body.receiver)
		.first<WebhookReceiver>();
	if (!receiver) return bad("no such receiver in this box", 404);

	let payload: Uint8Array;
	try {
		payload = body.bodyBase64
			? decodeBase64(body.bodyBase64)
			: new TextEncoder().encode(body.body ?? "");
	} catch {
		return bad("bodyBase64 is not valid base64");
	}

	const subpath = body.subpath ? `/${body.subpath.replace(/^\/+/, "")}` : "";
	const url = new URL(`https://${env.DOMAIN}/${HOOK_PREFIX}/${inbox}/${receiver.slug}${subpath}`);
	for (const [key, value] of Object.entries(body.query ?? {})) {
		url.searchParams.set(key, value);
	}

	const headers = new Headers(body.headers ?? {});
	if (body.contentType) headers.set("Content-Type", body.contentType);
	else if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");

	const method = (body.method ?? "POST").toUpperCase();
	const injected = new Request(url, {
		method,
		headers,
		body: method === "GET" || method === "HEAD" ? undefined : payload,
	});

	const outcome: ReceiveOutcome = {};
	const response = await serveWebhook(injected, env, url, ctx, outcome);
	const text = await response.text();
	let answered: unknown = text;
	try {
		answered = JSON.parse(text);
	} catch {
		// A receiver with a custom response body answers whatever it was told to.
	}

	return Response.json(
		{
			injected: response.status >= 200 && response.status < 300,
			id: outcome.id ?? null,
			duplicate: outcome.duplicate ?? false,
			event_status: outcome.status ?? null,
			receiver_status: response.status,
			receiver_response: answered,
		},
		{ status: response.status },
	);
}

/**
 * Destroy events, R2 bodies first so a surviving row never points at nothing.
 *
 * Three selectors, and at least one is required: naming no ids and no bulk form
 * would otherwise read as "delete the whole box", which is never what a typo
 * meant.
 */
export async function handleQueueDelete(
	request: Request,
	env: Env,
	inbox: string,
): Promise<Response> {
	const body = await readJson<DeleteBody>(request);
	const ids = idsFrom(body);
	if (!ids && !body?.removed && !body?.before) {
		return bad("ids, removed or before required -- refusing to destroy a whole box on a typo");
	}

	const filters = ["inbox = ?"];
	const params: (string | number)[] = [inbox];
	if (ids) {
		filters.push(`id IN (${placeholders(ids)})`);
		params.push(...ids);
	}
	if (body?.removed) filters.push("status = 'acked'");
	if (body?.before) {
		filters.push("id < ?");
		params.push(String(body.before));
	}

	const destroyed = await destroyWhere(env, filters.join(" AND "), params);
	return Response.json({ deleted: destroyed.length, ids: destroyed });
}

/** Destroy exactly one, by id, inside the box the gate approved. */
export async function handleQueueDeleteOne(env: Env, inbox: string, id: string): Promise<Response> {
	const destroyed = await destroyWhere(env, "inbox = ? AND id = ?", [inbox, id]);
	if (!destroyed.length) return Response.json({ error: "no such event" }, { status: 404 });
	return Response.json({ deleted: destroyed.length, ids: destroyed });
}

async function destroyWhere(
	env: Env,
	where: string,
	params: (string | number)[],
): Promise<string[]> {
	const { results } = await env.DB.prepare(
		`SELECT id, body_r2_key FROM webhook_events WHERE ${where}`,
	)
		.bind(...params)
		.all<{ id: string; body_r2_key: string | null }>();

	// The bodies go before the rows: an orphaned R2 object is invisible and
	// expensive, while a row pointing at a deleted object is a 410 to a consumer
	// that had every reason to expect bytes.
	for (const row of results) {
		if (row.body_r2_key) await env.BUCKET.delete(row.body_r2_key);
	}
	if (results.length) {
		await env.DB.prepare(`DELETE FROM webhook_events WHERE ${where}`)
			.bind(...params)
			.run();
	}

	return results.map((r) => r.id);
}

interface StatRow {
	status: string;
	count: number;
	bytes: number | null;
	newest: number | null;
	oldest: number | null;
}

/**
 * What is in this box: counts by status, bytes stored, and when the last thing
 * arrived. The one read here that is not about a specific event, and the reason
 * `queue-stats` does not need a D1 query to answer "is anything waiting".
 */
export async function handleQueueStats(env: Env, inbox: string): Promise<Response> {
	const { results } = await env.DB.withSession("first-unconstrained")
		.prepare(
			`SELECT status, COUNT(*) AS count, SUM(body_bytes) AS bytes,
			        MAX(created_at) AS newest, MIN(created_at) AS oldest
			   FROM webhook_events WHERE inbox = ? GROUP BY status`,
		)
		.bind(inbox)
		.all<StatRow>();

	const now = Date.now();
	const leased = await env.DB.withSession("first-unconstrained")
		.prepare(
			"SELECT COUNT(*) AS count FROM webhook_events WHERE inbox = ? AND status = 'leased' AND leased_until > ?",
		)
		.bind(inbox, now)
		.first<{ count: number }>();

	const byStatus: Record<string, number> = {};
	let total = 0;
	let bytes = 0;
	let newest: number | null = null;
	let oldest: number | null = null;
	for (const row of results) {
		byStatus[row.status] = row.count;
		total += row.count;
		bytes += row.bytes ?? 0;
		if (row.newest !== null && (newest === null || row.newest > newest)) newest = row.newest;
		if (row.oldest !== null && (oldest === null || row.oldest < oldest)) oldest = row.oldest;
	}

	return Response.json({
		inbox,
		total,
		bytes,
		by_status: byStatus,
		// A lease that has expired is back in the pool, so counting it as held would
		// tell an operator work is in flight when nobody is holding it.
		leased_now: leased?.count ?? 0,
		last_event_at: newest,
		first_event_at: oldest,
	});
}
