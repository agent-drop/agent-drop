/**
 * Reading the webhook queue -- `/api/hooks/queue/:box/...`.
 *
 * Everything in this file is a READ. Peek takes no lease and mutates nothing:
 * you can peek the same message a hundred times and the queue is exactly as it
 * was, which is the entire point when you are debugging a provider at 2am.
 * Leasing lives on the POST verbs (phase 4) so a peek stays retry-safe,
 * cacheable, and servable to a read-only credential -- and so you cannot consume
 * a queue by accident with a curl you meant as a look.
 *
 * Every query is filtered by `inbox` as well as by id: the inbox came from the
 * path and was scope-checked by the gate, so an id alone must never be enough to
 * read another box's event.
 */

import type { Env, WebhookEvent } from "../types";

const MAX_LIMIT = 200;

/** The row as listed: enough to decide what to look at, no bodies. */
const SUMMARY_COLUMNS = `id, receiver_id, inbox, slug, subpath, method, event_type, routing_key,
	content_type, body_bytes, body_sha256, verified, status, lease_count, leased_until,
	acked_at, created_at, expires_at`;

function parseJsonColumn(raw: string | null): unknown {
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

/** Full detail, including the stored headers and the body when it is text. */
export function detail(row: WebhookEvent) {
	const { headers, query, body_text, ...rest } = row;
	return {
		...rest,
		headers: parseJsonColumn(headers),
		query: parseJsonColumn(query),
		body: body_text,
		// A body that is not here is in R2 because it was too large or not UTF-8;
		// `queue-body` streams it back verbatim.
		body_available: body_text !== null || Boolean(row.body_r2_key),
	};
}

/**
 * Turn a `?receiver=` reference -- an id, the current slug, or the slug it had
 * before a rotation -- into the receiver id its events actually carry.
 *
 * Filtering on the events' own denormalized `slug` would have made rotation cost
 * history: every message stored under the old slug would vanish from
 * `--receiver <new-slug>` even though it is the same receiver, and §7 promises
 * the opposite. Null means no such receiver, in which case the caller falls back
 * to matching the raw string -- a deleted receiver's events are still findable by
 * the slug they were stored under.
 */
export async function resolveReceiverId(
	env: Env,
	inbox: string,
	ref: string,
): Promise<string | null> {
	const row = await env.DB.withSession("first-unconstrained")
		.prepare(
			`SELECT id FROM webhook_receivers
			  WHERE inbox = ? AND (id = ? OR slug = ? OR previous_slug = ?) LIMIT 1`,
		)
		.bind(inbox, ref, ref, ref)
		.first<{ id: string }>();
	return row?.id ?? null;
}

function limitFrom(url: URL, fallback = 20): number {
	const raw = Number.parseInt(url.searchParams.get("limit") || String(fallback), 10);
	if (!Number.isFinite(raw) || raw < 1) return fallback;
	return Math.min(raw, MAX_LIMIT);
}

/**
 * `?since=<id>` is an ARRIVAL cursor and nothing more. Ids are ULIDs, so
 * ordering by id is ordering by arrival MILLISECOND -- within a single
 * millisecond the random tail decides, so two events that landed together may
 * sort either way and a cursor walk can miss the one that sorted lower. The
 * lease queue (phase 4) is the crash-safe path for a consumer that cannot
 * tolerate that; `?since=` is for browsing and replay.
 *
 * Nor is arrival order event order: providers state outright that delivery order
 * is not guaranteed, so a consumer that cares must sort by the provider's own
 * timestamp inside the body. This will not pretend otherwise.
 */
async function selectEvents(
	env: Env,
	inbox: string,
	url: URL,
	columns: string,
): Promise<WebhookEvent[]> {
	const filters = ["inbox = ?"];
	const params: (string | number)[] = [inbox];

	const receiver = url.searchParams.get("receiver");
	if (receiver) {
		// Accept the receiver id or its slug -- the id is what the API returns, the
		// slug is what you remember -- and resolve it to the id, so a rotated
		// receiver's older messages answer to its new name.
		const ref = (await resolveReceiverId(env, inbox, receiver)) ?? receiver;
		filters.push("(receiver_id = ? OR slug = ?)");
		params.push(ref, receiver);
	}
	const status = url.searchParams.get("status");
	if (status) {
		filters.push("status = ?");
		params.push(status);
	}
	const key = url.searchParams.get("key");
	if (key) {
		filters.push("routing_key = ?");
		params.push(key);
	}
	const eventType = url.searchParams.get("event");
	if (eventType) {
		filters.push("event_type = ?");
		params.push(eventType);
	}
	const since = url.searchParams.get("since");
	if (since) {
		filters.push("id > ?");
		params.push(since);
	}

	const limit = limitFrom(url);
	// A `?since=` walk reads forward; everything else wants the newest first.
	const order = since ? "ASC" : "DESC";
	const { results } = await env.DB.withSession("first-unconstrained")
		.prepare(
			`SELECT ${columns} FROM webhook_events WHERE ${filters.join(" AND ")}
			  ORDER BY id ${order} LIMIT ?`,
		)
		.bind(...params, limit)
		.all<WebhookEvent>();
	return results;
}

export async function handleQueueList(env: Env, inbox: string, url: URL): Promise<Response> {
	const events = await selectEvents(env, inbox, url, SUMMARY_COLUMNS);
	return Response.json({ events, count: events.length });
}

/** Peek N, full detail, no lease. A GET would do; POST mirrors the CLI verb. */
export async function handleQueuePeek(env: Env, inbox: string, url: URL): Promise<Response> {
	const events = await selectEvents(env, inbox, url, "*");
	return Response.json({ events: events.map(detail), count: events.length });
}

async function loadEvent(env: Env, inbox: string, id: string): Promise<WebhookEvent | null> {
	return env.DB.withSession("first-unconstrained")
		.prepare("SELECT * FROM webhook_events WHERE id = ? AND inbox = ?")
		.bind(id, inbox)
		.first<WebhookEvent>();
}

export async function handleQueueOne(env: Env, inbox: string, id: string): Promise<Response> {
	const row = await loadEvent(env, inbox, id);
	if (!row) return Response.json({ error: "no such event" }, { status: 404 });
	return Response.json(detail(row));
}

/**
 * The raw bytes, exactly as the provider sent them, under the original
 * content-type. This is the endpoint the byte-fidelity promise is made to: a
 * consumer holding the provider's secret verifies its signature against what
 * comes back from here.
 */
export async function handleQueueBody(env: Env, inbox: string, id: string): Promise<Response> {
	const row = await loadEvent(env, inbox, id);
	if (!row) return Response.json({ error: "no such event" }, { status: 404 });

	const contentType = row.content_type || "application/octet-stream";
	const headers = {
		"Content-Type": contentType,
		"X-Body-Sha256": row.body_sha256 || "",
		"X-Content-Type-Options": "nosniff",
	};

	if (row.body_r2_key) {
		const object = await env.BUCKET.get(row.body_r2_key);
		if (!object) return Response.json({ error: "body no longer stored" }, { status: 410 });
		return new Response(object.body, { headers });
	}
	if (row.body_text === null) return new Response(null, { status: 204, headers });
	return new Response(row.body_text, { headers });
}
