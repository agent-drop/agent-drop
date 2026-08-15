/**
 * Turning a received body into the fields that get stored, without changing it.
 *
 * Every function here is one-way and total: it either produces a value or
 * produces null. None of them throws, because none of them is allowed to fail a
 * receive -- an unparseable or unrecognised body is a successful receive, and the
 * receiver's job is to preserve, not to understand.
 */

import type { WebhookReceiver } from "../types";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Decode only if the bytes really are UTF-8. `fatal` is the point: a lossy
 * decode would replace every bad byte with U+FFFD and store that instead, and
 * the original would be gone. When this returns null the body goes to R2 whole.
 *
 * `ignoreBOM: true` reads backwards but means "leave a leading U+FEFF in the
 * output" -- the default STRIPS it, which would make the text a silently
 * different string from the bytes.
 */
export function decodeUtf8(bytes: Uint8Array): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return null;
	}
}

/**
 * Parse for FIELD EXTRACTION ONLY. The result is never stored and never
 * re-serialized -- storing a re-serialized body is how you end up with a
 * signature nobody can verify, since key order, whitespace and unicode escaping
 * all shift on the way through.
 */
export function parseJson(text: string | null, contentType: string | null): unknown {
	if (text === null) return undefined;
	if (contentType && !/json/i.test(contentType)) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Read a JSON config column, treating a malformed one as absent. */
export function jsonConfig<T>(raw: string | null): T | null {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

/**
 * Header names this receiver's own config turns into credentials.
 *
 * The distinction this function exists to draw: `auth_config.header` names the
 * SHARED SECRET under `header` mode, and the SIGNATURE under `hmac` and `digest`.
 * Only the first is a credential.
 *
 * A shared secret rides every request unchanged, so anyone who reads one can
 * replay it forever -- it has to go. A signature proves one specific body came
 * from the signer and is worthless against any other request, so redacting it
 * costs nothing and destroys the one thing a faithful receiver exists to enable:
 * a consumer holding the provider's secret verifying the bytes we stored. Getting
 * this backwards is silent -- everything still works, and consumer-side
 * verification just quietly becomes impossible.
 *
 * `bearer`/`basic` put their secret in Authorization, which the fixed list
 * already covers, but they are named here so the intent is visible at the mode.
 */
const SIGNATURE_HEADER_MODES = new Set(["hmac", "digest"]);

interface AuthNames {
	header?: string;
	param?: string;
}

interface HandshakeNames {
	when?: { header?: Record<string, string>; query?: Record<string, string> };
}

export function secretHeaders(receiver: WebhookReceiver): string[] {
	const cfg = jsonConfig<AuthNames>(receiver.auth_config);
	const names: string[] = [];
	if (receiver.auth_mode === "bearer" || receiver.auth_mode === "basic")
		names.push("authorization");
	// Anything else that names a header means a secret. Only these two mean a
	// signature -- so the default stays "redact", and the exception is narrow.
	if (cfg?.header && !SIGNATURE_HEADER_MODES.has(receiver.auth_mode)) names.push(cfg.header);
	// A `static` handshake predicate compares a header against a configured value,
	// which makes that value a shared secret whatever the operator called it.
	if (receiver.handshake_mode === "static") {
		const when = jsonConfig<HandshakeNames>(receiver.handshake_config)?.when;
		names.push(...Object.keys(when?.header ?? {}));
	}
	return names;
}

/**
 * Query parameters this receiver's own config turns into credentials.
 *
 * A shared secret is no less a credential for arriving in a `?token=` than in a
 * header: it rides every request unchanged, so anyone who reads one replays it
 * forever, and these rows are readable for 120 days by any key with read on the
 * box. `collectQuery` used to copy the whole query string through untouched,
 * which was harmless only for as long as nothing named a parameter as a secret.
 *
 * The `hmac`/`digest` carve-out above does NOT extend here. No provider on the
 * list puts a signature in the query string; if one ever does it earns its own
 * line rather than a blanket exception.
 */
export function secretParams(receiver: WebhookReceiver): string[] {
	const names: string[] = [];
	if (receiver.auth_mode === "query") {
		names.push(jsonConfig<AuthNames>(receiver.auth_config)?.param ?? "token");
	}
	// Meta's verify token is the whole credential of its handshake, and it arrives
	// in the URL. `hub.mode` and `hub.challenge` are not secrets and stay readable.
	if (receiver.handshake_mode === "meta") names.push("hub.verify_token");
	if (receiver.handshake_mode === "static") {
		const when = jsonConfig<HandshakeNames>(receiver.handshake_config)?.when;
		names.push(...Object.keys(when?.query ?? {}));
	}
	return names;
}
