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

// Cache Google's JWKS keys in memory (Worker instance lifetime)
let cachedKeys: { keys: JsonWebKey[]; fetchedAt: number } | null = null;

async function getGoogleKeys(): Promise<JsonWebKey[]> {
	// Cache for 1 hour
	if (cachedKeys && Date.now() - cachedKeys.fetchedAt < 3600000) {
		return cachedKeys.keys;
	}

	const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
	const data = (await res.json()) as { keys: JsonWebKey[] };
	cachedKeys = { keys: data.keys, fetchedAt: Date.now() };
	return data.keys;
}

function base64UrlDecode(str: string): Uint8Array {
	// Pad with = if needed
	const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
	const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function verifyJWT(
	token: string,
	clientId: string,
): Promise<GoogleJWTPayload | null> {
	const parts = token.split(".");
	if (parts.length !== 3) return null;

	const [headerB64, payloadB64, signatureB64] = parts;

	// Decode header to find key ID
	const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)));
	const kid = header.kid;
	if (!kid || header.alg !== "RS256") return null;

	// Find matching key
	const keys = await getGoogleKeys();
	const jwk = keys.find((k: any) => k.kid === kid);
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

	// Check expiry
	if (payload.exp * 1000 < Date.now()) return null;

	// Check issuer
	if (payload.iss !== "accounts.google.com" && payload.iss !== "https://accounts.google.com") {
		return null;
	}

	// Check audience matches our client ID
	if (payload.aud !== clientId) return null;

	// Check email is verified
	if (!payload.email_verified) return null;

	return payload;
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
	const allowed = await env.DB.prepare(
		"SELECT email FROM allowed_users WHERE email = ?",
	)
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
