import { generateApiKey } from "../lib/auth";
import type { Env, ApiKey } from "../types";

export async function handleKeys(
	request: Request,
	env: Env,
	url: URL,
): Promise<Response> {
	const method = request.method;

	// POST /api/keys - create key
	if (method === "POST") {
		const body = (await request.json()) as {
			name: string;
			inbox_scope?: string;
			permissions?: string;
		};

		if (!body.name) {
			return Response.json({ error: "name required" }, { status: 400 });
		}

		const key = await generateApiKey(
			env,
			body.name,
			body.inbox_scope || null,
			body.permissions || "read",
		);

		return Response.json({ key, name: body.name }, { status: 201 });
	}

	// DELETE /api/keys/:id
	const deleteMatch = url.pathname.match(/^\/api\/keys\/(.+)$/);
	if (method === "DELETE" && deleteMatch) {
		await env.DB.prepare("DELETE FROM api_keys WHERE id = ?")
			.bind(deleteMatch[1])
			.run();
		return Response.json({ deleted: true });
	}

	// GET /api/keys - list keys
	const { results } = await env.DB.prepare(
		"SELECT id, name, inbox_scope, permissions, created_at, last_used_at FROM api_keys ORDER BY created_at DESC",
	).all<Omit<ApiKey, "key_hash">>();

	return Response.json({ keys: results });
}
