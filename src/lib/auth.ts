import { constantTimeEqual } from "./compare";
import type { Env } from "../types";

export const API_KEY_PERMISSIONS = ["read", "write", "admin"] as const;
export type ApiKeyPermission = (typeof API_KEY_PERMISSIONS)[number];

export function isApiKeyPermission(value: unknown): value is ApiKeyPermission {
	return typeof value === "string" && API_KEY_PERMISSIONS.includes(value as ApiKeyPermission);
}

export async function hashKey(key: string): Promise<string> {
	const encoded = new TextEncoder().encode(key);
	const hash = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function validateApiKey(
	env: Env,
	request: Request,
	ctx?: ExecutionContext,
): Promise<{
	valid: boolean;
	inboxScope: string | null;
	permissions: string;
	keyName: string | null;
}> {
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
	if (!isApiKeyPermission(row.permissions)) {
		return { valid: false, inboxScope: null, permissions: "", keyName: null };
	}

	// `last_used_at` is bookkeeping: nothing in the request's answer depends on
	// it, but awaiting it put a serialized D1 write in the critical path of EVERY
	// authenticated request, read paths included. Defer it -- the Worker stays
	// alive until it settles, the caller does not wait for it.
	//
	// It is also swallowed on failure on purpose. A transient D1 error on a
	// bookkeeping write must not turn an otherwise-valid request into an error,
	// and an unhandled rejection inside waitUntil is noise in Workers Logs. The
	// cost of losing one is a stale timestamp.
	const touch = env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?")
		.bind(Date.now(), keyHash)
		.run()
		.then(
			() => {},
			(err: unknown) => {
				console.error("last_used_at update failed:", err);
			},
		);
	if (ctx) ctx.waitUntil(touch);
	else await touch;

	return {
		valid: true,
		inboxScope: row.inbox_scope,
		permissions: row.permissions,
		keyName: row.name,
	};
}

export async function isAdmin(request: Request, env: Env): Promise<boolean> {
	const auth = request.headers.get("Authorization");
	if (!auth?.startsWith("Bearer ")) return false;

	// An unset secret must authenticate nothing. The old check was
	// `auth === \`Bearer ${env.ADMIN_API_KEY}\``, which with the secret missing
	// interpolates to exactly "Bearer " -- so a half-deployed worker handed admin
	// to anyone who sent an empty bearer token.
	const expected = env.ADMIN_API_KEY;
	if (!expected) return false;

	// Compare digests, not the raw credential. `===` on strings bails at the first
	// differing byte, so its runtime leaks how long a prefix of the master key the
	// caller guessed right, one byte at a time. A SHA-256 digest is fixed-length
	// and uncorrelated with the secret's bytes, so the compare says nothing.
	const [got, want] = await Promise.all([hashKey(auth.slice(7)), hashKey(expected)]);
	return constantTimeEqual(got, want);
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
