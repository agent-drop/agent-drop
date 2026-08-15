/**
 * Deciding whether a received request really came from the provider it claims.
 *
 * The contract with the receive path is three-valued and deliberate:
 *
 *   1    the signature checked out
 *   0    it did not -- 401, and the event is stored `rejected` as evidence
 *   null nothing was asked for (`auth_mode: none`), which is a first-class
 *        answer rather than a half-configured one
 *
 * There is no fourth value for "we could not be bothered". A mode nothing here
 * implements resolves to 0, because writing 1 for a signature no code checked
 * would be a lie in the database that a consumer would then trust.
 *
 * Everything is verified against the RAW BYTES the receive path read once and
 * hashed. Nothing in this file ever sees `body_text`, and nothing re-serializes a
 * parsed body: key order, whitespace and unicode escaping all shift on the way
 * through a parse, and a verifier built on the re-encoded form rejects every real
 * request the provider ever sends.
 */

import { constantTimeEqual } from "./compare";
import { jsonConfig } from "./webhook-body";
import {
	buildSignedBytes,
	decodeBase64,
	digestBytes,
	hmacBytes,
	matchesAny,
} from "./webhook-crypto";
import { type AuthConfig, SCHEMES, type SignedScheme } from "./webhook-schemes";
import type { WebhookReceiver } from "../types";

/** Every auth_mode this build can actually honour. `none` is added by the caller. */
export const VERIFIER_MODES = [...Object.keys(SCHEMES), "bearer", "basic", "header", "query"];

export interface VerifyResult {
	/** 1 pass, 0 fail, null not applicable. Goes straight into `verified`. */
	verified: 1 | 0 | null;
	/** Why it failed. For the operator's logs, never for the caller's response. */
	reason: string | null;
}

export interface VerifyInput {
	receiver: WebhookReceiver;
	headers: Headers;
	url: URL;
	method: string;
	/** The bytes exactly as they arrived. The only thing that is ever verified. */
	bytes: Uint8Array;
	now: number;
}

const PASS: VerifyResult = { verified: 1, reason: null };
const SKIP: VerifyResult = { verified: null, reason: null };

function reject(reason: string): VerifyResult {
	return { verified: 0, reason };
}

export async function verifyWebhook(input: VerifyInput): Promise<VerifyResult> {
	const mode = input.receiver.auth_mode || "none";
	if (mode === "none") return SKIP;

	const cfg = jsonConfig<AuthConfig>(input.receiver.auth_config) ?? {};

	try {
		const scheme = SCHEMES[mode];
		if (scheme) {
			const resolved = scheme(input.headers, cfg);
			return typeof resolved === "string"
				? reject(resolved)
				: await checkSignature(input, resolved);
		}
		const shared = SHARED[mode];
		if (shared) return shared(input, cfg);
		return reject(`auth_mode '${mode}' is not implemented`);
	} catch (err) {
		// A malformed header is the caller's problem, not ours: it must come out as a
		// 401 rather than escaping into the receive path's 503, which is the one
		// status that tells a provider to retry.
		return reject(`verification error: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function checkSignature(input: VerifyInput, scheme: SignedScheme): Promise<VerifyResult> {
	if (!scheme.secret) return reject("no secret configured");
	if (!scheme.signatures.length) return reject(`no signature in ${scheme.header}`);

	const stale = checkReplayWindow(scheme, input.now);
	if (stale) return stale;

	const message = buildSignedBytes(scheme.template, {
		body: input.bytes,
		ts: scheme.timestamp ?? "",
		// `t` is stripe's own name for it; accepting both means a hand-written
		// template can copy the provider's docs verbatim.
		t: scheme.timestamp ?? "",
		id: scheme.id ?? "",
		secret: scheme.secret,
		method: input.method,
		path: input.url.pathname,
		url: input.url.toString(),
	});

	const expected = scheme.plain
		? await digestBytes(message, scheme.algorithm)
		: await hmacBytes(scheme.key, message, scheme.algorithm);

	return matchesAny(expected, scheme.signatures, scheme.encoding)
		? PASS
		: reject("signature mismatch");
}

/**
 * A signature proves the body came from the signer; it does not prove the body is
 * not a replay of one it sent an hour ago. Schemes that put a timestamp in the
 * signed string get a window, so a captured request stops being useful.
 *
 * `toleranceSeconds: 0` turns it off on purpose -- some providers' clocks are bad
 * enough that a window costs more deliveries than it saves.
 */
function checkReplayWindow(scheme: SignedScheme, now: number): VerifyResult | null {
	const tolerance = scheme.toleranceSeconds;
	if (tolerance === null || tolerance <= 0) return null;

	const seconds = Number(scheme.timestamp);
	if (!scheme.timestamp || !Number.isFinite(seconds)) return reject("no usable timestamp");

	// Both directions: a timestamp from the future is a clock problem or a forgery,
	// and neither is something to accept quietly.
	const drift = Math.abs(Math.floor(now / 1000) - seconds);
	return drift > tolerance ? reject(`timestamp outside the ${tolerance}s window`) : null;
}

/**
 * The schemes with no cryptography in them: the request carries a shared secret
 * and we compare it. Weak, and popular anyway -- a provider that offers nothing
 * else is better verified this way than not at all.
 */
type SharedCheck = (input: VerifyInput, cfg: AuthConfig) => VerifyResult;

const SHARED: Record<string, SharedCheck> = {
	bearer(input, cfg) {
		const expected = cfg.secret ?? cfg.value;
		if (!expected) return reject("no secret configured");
		const auth = input.headers.get("authorization") ?? "";
		if (!/^Bearer /i.test(auth)) return reject("no bearer token");
		return constantTimeEqual(auth.slice(7), expected) ? PASS : reject("bearer token mismatch");
	},

	basic(input, cfg) {
		// Compared decoded, so base64 padding and casing cannot make a correct
		// credential look wrong.
		const expected =
			cfg.secret ?? (cfg.username !== undefined ? `${cfg.username}:${cfg.password ?? ""}` : null);
		if (!expected) return reject("no credential configured");
		const auth = input.headers.get("authorization") ?? "";
		if (!/^Basic /i.test(auth)) return reject("no basic credential");
		const decoded = decodeBase64(auth.slice(6).trim());
		if (!decoded) return reject("basic credential is not base64");
		return constantTimeEqual(new TextDecoder().decode(decoded), expected)
			? PASS
			: reject("basic credential mismatch");
	},

	header(input, cfg) {
		if (!cfg.header) return reject("auth_config.header is required for header mode");
		const expected = cfg.value ?? cfg.secret;
		if (!expected) return reject("no secret configured");
		const got = input.headers.get(cfg.header);
		if (got === null) return reject(`no ${cfg.header} header`);
		return constantTimeEqual(got, expected) ? PASS : reject(`${cfg.header} mismatch`);
	},

	query(input, cfg) {
		const param = cfg.param ?? "token";
		const expected = cfg.value ?? cfg.secret;
		if (!expected) return reject("no secret configured");
		const got = input.url.searchParams.get(param);
		if (got === null) return reject(`no ?${param} parameter`);
		return constantTimeEqual(got, expected) ? PASS : reject(`?${param} mismatch`);
	},
};
