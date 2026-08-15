import type { Env } from "../types";

/**
 * `envelope` is agent-drop's JSON wrapper; `passthrough` re-sends the provider's
 * original bytes and headers. Passthrough needs a stored request to re-send, so
 * it only means something on the `hook` channel -- a rule that matches a drop
 * sends the envelope regardless (see `rule-payload.ts`).
 */
const PAYLOAD_MODES = ["envelope", "passthrough"];

function payloadModeError(value: unknown): string | null {
	if (value === undefined) return null;
	if (typeof value === "string" && PAYLOAD_MODES.includes(value)) return null;
	return `payloadMode must be one of: ${PAYLOAD_MODES.join(", ")}`;
}

export async function handleRules(request: Request, env: Env, url: URL): Promise<Response> {
	const method = request.method;
	const path = url.pathname;

	// POST /api/rules - create rule
	if (method === "POST" && path === "/api/rules") {
		const body = (await request.json()) as {
			pattern: string;
			type: "forward" | "webhook";
			scopes?: string;
			target: string;
			headers?: Record<string, string>;
			priority?: number;
			payloadMode?: string;
		};

		if (!body.pattern || !body.type || !body.target) {
			return Response.json({ error: "pattern, type, and target required" }, { status: 400 });
		}
		if (body.type !== "forward" && body.type !== "webhook" && body.type !== "relay") {
			return Response.json(
				{ error: "type must be 'forward', 'webhook', or 'relay'" },
				{ status: 400 },
			);
		}
		const badMode = payloadModeError(body.payloadMode);
		if (badMode) return Response.json({ error: badMode }, { status: 400 });

		const id = crypto.randomUUID();
		await env.DB.prepare(
			`INSERT INTO drop_rules (id, pattern, type, scopes, target, headers, priority,
				payload_mode, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				id,
				body.pattern,
				body.type,
				body.scopes || "all",
				body.target,
				body.headers ? JSON.stringify(body.headers) : null,
				body.priority || 0,
				body.payloadMode || "envelope",
				Date.now(),
			)
			.run();

		return Response.json(
			{
				id,
				pattern: body.pattern,
				type: body.type,
				target: body.target,
				payload_mode: body.payloadMode || "envelope",
			},
			{ status: 201 },
		);
	}

	// PATCH /api/rules/:id - update rule (enable/disable, change target, etc)
	const patchMatch = path.match(/^\/api\/rules\/([^/]+)$/);
	if (method === "PATCH" && patchMatch) {
		const body = (await request.json()) as {
			enabled?: boolean;
			target?: string;
			scopes?: string;
			headers?: Record<string, string>;
			priority?: number;
			payloadMode?: string;
		};
		const id = patchMatch[1];
		const badMode = payloadModeError(body.payloadMode);
		if (badMode) return Response.json({ error: badMode }, { status: 400 });
		const updates: string[] = [];
		const params: (string | number)[] = [];

		if (body.enabled !== undefined) {
			updates.push("enabled = ?");
			params.push(body.enabled ? 1 : 0);
		}
		if (body.target) {
			updates.push("target = ?");
			params.push(body.target);
		}
		if (body.scopes) {
			updates.push("scopes = ?");
			params.push(body.scopes);
		}
		if (body.headers) {
			updates.push("headers = ?");
			params.push(JSON.stringify(body.headers));
		}
		if (body.priority !== undefined) {
			updates.push("priority = ?");
			params.push(body.priority);
		}
		if (body.payloadMode !== undefined) {
			updates.push("payload_mode = ?");
			params.push(body.payloadMode);
		}

		if (updates.length === 0) {
			return Response.json({ error: "nothing to update" }, { status: 400 });
		}

		params.push(id);
		await env.DB.prepare(`UPDATE drop_rules SET ${updates.join(", ")} WHERE id = ?`)
			.bind(...params)
			.run();

		return Response.json({ updated: id });
	}

	// DELETE /api/rules/:id
	const deleteMatch = path.match(/^\/api\/rules\/([^/]+)$/);
	if (method === "DELETE" && deleteMatch) {
		await env.DB.prepare("DELETE FROM drop_rules WHERE id = ?").bind(deleteMatch[1]).run();
		return Response.json({ deleted: true });
	}

	// GET /api/rules/:id/log - delivery log for a specific rule
	const logMatch = path.match(/^\/api\/rules\/([^/]+)\/log$/);
	if (method === "GET" && logMatch) {
		const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
		const { results } = await env.DB.prepare(
			"SELECT * FROM delivery_log WHERE rule_id = ? ORDER BY created_at DESC LIMIT ?",
		)
			.bind(logMatch[1], limit)
			.all();
		return Response.json({ deliveries: results });
	}

	// GET /api/deliveries - delivery log (optionally filtered by drop_id)
	if (method === "GET" && path === "/api/deliveries") {
		const dropId = url.searchParams.get("drop_id");
		const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
		const status = url.searchParams.get("status");

		let query = "SELECT * FROM delivery_log WHERE 1=1";
		const params: (string | number)[] = [];

		if (dropId) {
			query += " AND drop_id = ?";
			params.push(dropId);
		}
		if (status) {
			query += " AND status = ?";
			params.push(status);
		}

		query += " ORDER BY created_at DESC LIMIT ?";
		params.push(limit);

		const { results } = await env.DB.prepare(query)
			.bind(...params)
			.all();
		return Response.json({ deliveries: results });
	}

	// GET /api/rules - list all rules
	if (method === "GET") {
		const { results } = await env.DB.prepare(
			"SELECT * FROM drop_rules ORDER BY priority DESC, created_at ASC",
		).all();

		// Parse headers JSON for display
		const rules = results.map((r: any) => ({
			...r,
			headers: r.headers ? JSON.parse(r.headers) : null,
		}));

		return Response.json({ rules });
	}

	return Response.json({ error: "method not allowed" }, { status: 405 });
}
