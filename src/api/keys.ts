import { API_KEY_PERMISSIONS, generateApiKey, isApiKeyPermission } from "../lib/auth";
import { normalizeInbox } from "../lib/normalize";
import type { Env, ApiKey } from "../types";

export async function handleKeys(request: Request, env: Env, url: URL): Promise<Response> {
	const method = request.method;

	// POST /api/keys - create key
	if (method === "POST") {
		let body: Record<string, unknown>;
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			return Response.json({ error: "invalid JSON body" }, { status: 400 });
		}

		if (typeof body.name !== "string" || !body.name.trim()) {
			return Response.json({ error: "name required" }, { status: 400 });
		}
		const permissions =
			body.permissions === undefined || body.permissions === null || body.permissions === ""
				? "read"
				: body.permissions;
		if (!isApiKeyPermission(permissions)) {
			return Response.json(
				{ error: `permissions must be one of: ${API_KEY_PERMISSIONS.join(", ")}` },
				{ status: 400 },
			);
		}

		let inboxScope: string | null = null;
		if (body.inbox_scope !== undefined && body.inbox_scope !== null && body.inbox_scope !== "") {
			if (typeof body.inbox_scope !== "string") {
				return Response.json({ error: "inbox_scope must be a valid inbox name" }, { status: 400 });
			}
			inboxScope = normalizeInbox(body.inbox_scope);
			if (!inboxScope) {
				return Response.json({ error: "inbox_scope must be a valid inbox name" }, { status: 400 });
			}
		}

		const key = await generateApiKey(env, body.name, inboxScope, permissions);

		return Response.json({ key, name: body.name }, { status: 201 });
	}

	// DELETE /api/keys/:id
	const deleteMatch = url.pathname.match(/^\/api\/keys\/(.+)$/);
	if (method === "DELETE" && deleteMatch) {
		await env.DB.prepare("DELETE FROM api_keys WHERE id = ?").bind(deleteMatch[1]).run();
		return Response.json({ deleted: true });
	}

	// GET /api/keys - list keys
	const { results } = await env.DB.prepare(
		"SELECT id, name, inbox_scope, permissions, created_at, last_used_at FROM api_keys ORDER BY created_at DESC",
	).all<Omit<ApiKey, "key_hash">>();

	return Response.json({ keys: results });
}
