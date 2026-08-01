/**
 * The two cross-inbox listings behind the admin credential.
 *
 * They used to be written out inline in the dispatcher, which is how ~50 lines
 * of SQL ended up living in a file whose job is to pick a handler.
 */

import type { Env } from "../types";

/** GET /api/drops - every drop across every inbox, newest first. */
export async function handleDropsList(env: Env, url: URL): Promise<Response> {
	const limit = Math.min(Number.parseInt(url.searchParams.get("limit") || "50", 10), 200);
	const since = url.searchParams.get("since");
	const channel = url.searchParams.get("channel");

	let query = "SELECT * FROM drops WHERE 1=1";
	const params: (string | number)[] = [];

	if (since) {
		query += " AND created_at > ?";
		params.push(Number.parseInt(since, 10));
	}
	if (channel) {
		query += " AND channel = ?";
		params.push(channel);
	}

	query += " ORDER BY created_at DESC LIMIT ?";
	params.push(limit);

	// Read-only listing: nearest consistent replica, not the primary. See the
	// note in src/api/inbox.ts for what `first-unconstrained` trades away.
	const { results } = await env.DB.withSession("first-unconstrained")
		.prepare(query)
		.bind(...params)
		.all();

	return Response.json({ count: results.length, drops: results });
}

/** GET /api/boxes - one row per inbox, with drop stats and live token counts. */
export async function handleBoxesList(env: Env): Promise<Response> {
	// Both queries share ONE session, so the token counts cannot come from a
	// replica older than the one the box list came from.
	const db = env.DB.withSession("first-unconstrained");

	const { results } = await db
		.prepare(`
			SELECT
				inbox,
				COUNT(*) as total_drops,
				SUM(attachment_count) as total_files,
				MAX(created_at) as last_drop_at,
				SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) as unread,
				GROUP_CONCAT(DISTINCT channel) as channels
			FROM drops
			GROUP BY inbox
			ORDER BY last_drop_at DESC
		`)
		.all<{ inbox: string }>();

	const { results: tokens } = await db
		.prepare(
			"SELECT inbox, COUNT(*) as active_tokens FROM drop_tokens WHERE expires_at > ? GROUP BY inbox",
		)
		.bind(Date.now())
		.all<{ inbox: string; active_tokens: number }>();

	const tokenMap = new Map(tokens.map((t) => [t.inbox, t.active_tokens]));
	const boxes = results.map((r) => ({ ...r, active_tokens: tokenMap.get(r.inbox) || 0 }));

	return Response.json({ count: boxes.length, boxes });
}
