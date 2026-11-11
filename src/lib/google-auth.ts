import type { Env } from "../types";

interface GoogleJWTPayload {
	iss: string;
	azp: string;
	aud: string;
	sub: string;
	email: string;
	email_verified: boolean;
	name: string;
	picture: string;
	exp: number;
	iat: number;
}

interface GoogleJWK extends JsonWebKey {
	kid?: string;
}

export const MAX_GOOGLE_TOKEN_LENGTH = 16 * 1024;
const UNKNOWN_KID_REFRESH_COOLDOWN_MS = 60_000;

// Cache Google's JWKS keys in memory (Worker instance lifetime)
let cachedKeys: { keys: GoogleJWK[]; fetchedAt: number } | null = null;
let lastUnknownKidRefreshAt = 0;

async function getGoogleKeys(
	forceRefresh = false,
): Promise<{ keys: GoogleJWK[]; cacheHit: boolean }> {
	// Cache for 1 hour
	if (!forceRefresh && cachedKeys && Date.now() - cachedKeys.fetchedAt < 3600000) {
		return { keys: cachedKeys.keys, cacheHit: true };
	}

	const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
	if (!res.ok) throw new Error(`google jwks request failed (${res.status})`);
	const data = (await res.json()) as { keys?: unknown };
	if (!Array.isArray(data?.keys) || data.keys.some((key) => !key || typeof key !== "object")) {
		throw new Error("google jwks response is malformed");
	}
	const keys = data.keys as GoogleJWK[];
	cachedKeys = { keys, fetchedAt: Date.now() };
	return { keys, cacheHit: false };
}

function base64UrlDecode(str: string): Uint8Array {
	// Pad with = if needed
	const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
	const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function verifyJWTUnchecked(
	token: string,
	clientId: string,
): Promise<GoogleJWTPayload | null> {
	if (token.length > MAX_GOOGLE_TOKEN_LENGTH) return null;
	const parts = token.split(".");
	if (parts.length !== 3) return null;

	const [headerB64, payloadB64, signatureB64] = parts;

	// Decode header to find key ID
	const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64))) as {
		alg?: unknown;
		kid?: unknown;
	};
	const kid = header.kid;
	if (typeof kid !== "string" || !kid || header.alg !== "RS256") return null;

	// Google may rotate keys while an isolate still holds the prior set. Refresh
	// once on a cache miss, with a cooldown so random key ids cannot turn token
	// validation into an outbound-request amplifier.
	let keySet = await getGoogleKeys();
	let jwk = keySet.keys.find((key) => key.kid === kid);
	if (
		!jwk &&
		keySet.cacheHit &&
		Date.now() - lastUnknownKidRefreshAt >= UNKNOWN_KID_REFRESH_COOLDOWN_MS
	) {
		lastUnknownKidRefreshAt = Date.now();
		keySet = await getGoogleKeys(true);
		jwk = keySet.keys.find((key) => key.kid === kid);
	}
	if (!jwk) return null;

	// Import the key
	const cryptoKey = await crypto.subtle.importKey(
		"jwk",
		jwk,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["verify"],
	);

	// Verify signature
	const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
	const signature = base64UrlDecode(signatureB64);
	const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature, data);
	if (!valid) return null;

	// Decode and validate payload
	const payload = JSON.parse(
		new TextDecoder().decode(base64UrlDecode(payloadB64)),
	) as GoogleJWTPayload;
	if (!payload || typeof payload !== "object") return null;

	// Check expiry
	if (!Number.isFinite(payload.exp) || payload.exp * 1000 < Date.now()) return null;

	// Check issuer
	if (payload.iss !== "accounts.google.com" && payload.iss !== "https://accounts.google.com") {
		return null;
	}

	// Check audience matches our client ID
	if (payload.aud !== clientId) return null;

	// Check email is verified
	if (!payload.email_verified || typeof payload.email !== "string" || !payload.email) return null;

	return payload;
}

async function verifyJWT(token: string, clientId: string): Promise<GoogleJWTPayload | null> {
	try {
		return await verifyJWTUnchecked(token, clientId);
	} catch {
		return null;
	}
}

/** Clear isolate-local state so tests never depend on execution order. */
export function clearGoogleKeyCache(): void {
	cachedKeys = null;
	lastUnknownKidRefreshAt = 0;
}

export async function validateGoogleToken(
	env: Env,
	token: string,
): Promise<{ valid: boolean; email: string | null; name: string | null; denied?: boolean }> {
	const clientId = env.GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID_PUBLIC;
	if (!clientId) return { valid: false, email: null, name: null };

	const payload = await verifyJWT(token, clientId);
	if (!payload) return { valid: false, email: null, name: null };

	// Check allowlist
	const allowed = await env.DB.prepare("SELECT email FROM allowed_users WHERE email = ?")
		.bind(payload.email)
		.first();

	if (!allowed) {
		return { valid: false, email: payload.email, name: payload.name, denied: true };
	}

	return {
		valid: true,
		email: payload.email,
		name: payload.name,
	};
}
