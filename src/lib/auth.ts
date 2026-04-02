import type { Env } from "../types";

async function hashKey(key: string): Promise<string> {
	const encoded = new TextEncoder().encode(key);
	const hash = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function validateApiKey(
	env: Env,
	request: Request,
): Promise<{ valid: boolean; inboxScope: string | null; permissions: string; keyName: string | null }> {
	const auth = request.headers.get("Authorization");
	if (!auth?.startsWith("Bearer ")) {
		return { valid: false, inboxScope: null, permissions: "", keyName: null };
	}

	const key = auth.slice(7);
	const keyHash = await hashKey(key);

	const row = await env.DB.prepare(
		"SELECT name, inbox_scope, permissions FROM api_keys WHERE key_hash = ?",
	)
		.bind(keyHash)
		.first<{ name: string; inbox_scope: string | null; permissions: string }>();

	if (!row) {
		return { valid: false, inboxScope: null, permissions: "", keyName: null };
	}

	// Update last_used_at
	await env.DB.prepare(
		"UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?",
	)
		.bind(Date.now(), keyHash)
		.run();

	return {
		valid: true,
		inboxScope: row.inbox_scope,
		permissions: row.permissions,
		keyName: row.name,
	};
}

export function isAdmin(request: Request, env: Env): boolean {
	const auth = request.headers.get("Authorization");
	return auth === `Bearer ${env.ADMIN_API_KEY}`;
}

export async function generateApiKey(
	env: Env,
	name: string,
	inboxScope: string | null,
	permissions: string,
): Promise<string> {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const key =
		"ad_" +
		Array.from(bytes)
			.map((b) => b.toString(36).padStart(2, "0"))
			.join("")
			.slice(0, 40);

	const keyHash = await hashKey(key);
	const id = crypto.randomUUID();

	await env.DB.prepare(
		"INSERT INTO api_keys (id, key_hash, name, inbox_scope, permissions, created_at) VALUES (?, ?, ?, ?, ?, ?)",
	)
		.bind(id, keyHash, name, inboxScope, permissions, Date.now())
		.run();

	return key;
}
