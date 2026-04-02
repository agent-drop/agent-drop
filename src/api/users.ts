import type { Env } from "../types";

export async function handleUsers(
	request: Request,
	env: Env,
	url: URL,
): Promise<Response> {
	const method = request.method;

	// POST /api/users - add user
	if (method === "POST") {
		const body = (await request.json()) as { email: string; name?: string };
		if (!body.email) {
			return Response.json({ error: "email required" }, { status: 400 });
		}

		const email = body.email.toLowerCase().trim();
		await env.DB.prepare(
			"INSERT OR IGNORE INTO allowed_users (email, name, added_by, created_at) VALUES (?, ?, 'api', ?)",
		)
			.bind(email, body.name || null, Date.now())
			.run();

		return Response.json({ added: email }, { status: 201 });
	}

	// DELETE /api/users/:email
	const deleteMatch = url.pathname.match(/^\/api\/users\/(.+)$/);
	if (method === "DELETE" && deleteMatch) {
		const email = decodeURIComponent(deleteMatch[1]).toLowerCase();
		await env.DB.prepare("DELETE FROM allowed_users WHERE email = ?")
			.bind(email)
			.run();
		return Response.json({ deleted: email });
	}

	// GET /api/users - list
	const { results } = await env.DB.prepare(
		"SELECT email, name, added_by, created_at FROM allowed_users ORDER BY created_at DESC",
	).all();

	return Response.json({ users: results });
}
