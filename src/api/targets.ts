import type { Env } from "../types";
import { normalizeInbox } from "../lib/normalize";

async function hashToken(token: string): Promise<string> {
	const encoded = new TextEncoder().encode(token);
	const hash = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function handleTargets(
	request: Request,
	env: Env,
	url: URL,
): Promise<Response> {
	const method = request.method;

	// POST /api/targets - create temporary drop target
	if (method === "POST") {
		const body = (await request.json()) as {
			inbox: string;
			ttl_hours?: number;
			created_by?: string;
		};

		if (!body.inbox) {
			return Response.json({ error: "inbox required" }, { status: 400 });
		}

		const normalized = normalizeInbox(body.inbox);
		if (!normalized) {
			return Response.json({ error: "invalid inbox name" }, { status: 400 });
		}
		body.inbox = normalized;
		const ttlHours = body.ttl_hours ?? 2;
		const expiresAt = Date.now() + ttlHours * 60 * 60 * 1000;

		// Generate token
		const bytes = crypto.getRandomValues(new Uint8Array(24));
		const token = Array.from(bytes)
			.map((b) => b.toString(36).padStart(2, "0"))
			.join("")
			.slice(0, 32);

		const tokenHash = await hashToken(token);
		const id = crypto.randomUUID();

		await env.DB.prepare(
			"INSERT INTO drop_tokens (id, inbox, token_hash, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
			.bind(id, body.inbox, tokenHash, expiresAt, body.created_by || null, Date.now())
			.run();

		const dropUrl = `https://${env.DOMAIN}/${body.inbox}?auth=${token}`;

		return Response.json(
			{
				id,
				inbox: body.inbox,
				url: dropUrl,
				token,
				expires_at: expiresAt,
				expires_in: `${ttlHours}h`,
			},
			{ status: 201 },
		);
	}

	// GET /api/targets - list active targets
	if (method === "GET") {
		const { results } = await env.DB.prepare(
			"SELECT id, inbox, expires_at, created_by, created_at FROM drop_tokens WHERE expires_at > ? ORDER BY created_at DESC",
		)
			.bind(Date.now())
			.all();

		return Response.json({ targets: results });
	}

	// DELETE /api/targets/:id - revoke target
	const deleteMatch = url.pathname.match(/^\/api\/targets\/(.+)$/);
	if (method === "DELETE" && deleteMatch) {
		await env.DB.prepare("DELETE FROM drop_tokens WHERE id = ?")
			.bind(deleteMatch[1])
			.run();
		return Response.json({ deleted: true });
	}

	return Response.json({ error: "method not allowed" }, { status: 405 });
}

// Validate a drop token from ?auth= query param
export async function validateDropToken(
	env: Env,
	token: string,
): Promise<{ valid: boolean; inbox: string | null }> {
	const tokenHash = await hashToken(token);

	const row = await env.DB.prepare(
		"SELECT inbox, expires_at FROM drop_tokens WHERE token_hash = ?",
	)
		.bind(tokenHash)
		.first<{ inbox: string; expires_at: number }>();

	if (!row) return { valid: false, inbox: null };
	if (row.expires_at < Date.now()) return { valid: false, inbox: null };

	return { valid: true, inbox: row.inbox };
}
