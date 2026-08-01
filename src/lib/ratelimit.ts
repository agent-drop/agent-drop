import type { Env } from "../types";
import { hashKey } from "./auth";

// Workers rate limiting.
//
// READ THIS BEFORE DESCRIBING IT AS A QUOTA: the binding counts PER
// COLOCATION. Every Cloudflare location the worker runs in keeps its own
// counter, so the real ceiling is roughly (limit x number of colos an attacker
// can reach), and a distributed client gets a fresh budget in every one. This
// makes online brute force and leaked-link abuse impractical. It is NOT a hard
// cap, it is NOT a billing control, and nothing downstream may assume a global
// number.
//
// The limiter also fails OPEN -- a missing binding (local dev, tests) or an
// error from the service lets the request through. A throttle that turns its own
// outage into an API outage is worse than the abuse it prevents.

async function consume(limiter: RateLimit | undefined, key: string): Promise<boolean> {
	if (!limiter) return true;
	try {
		const { success } = await limiter.limit({ key });
		return success;
	} catch (err) {
		console.error("rate limiter unavailable, failing open:", err);
		return true;
	}
}

/**
 * Burn a token from the per-client failed-authentication bucket.
 *
 * Called only when a *credential* was rejected (unknown API key, bad or expired
 * drop token, wrong admin key) -- not when a valid credential merely lacked a
 * permission or a scope, which is a misconfigured client rather than a guess.
 * Returns false once the bucket is empty, at which point the caller should
 * answer 429 instead of running another attempt.
 */
export async function recordAuthFailure(env: Env, request: Request): Promise<boolean> {
	const ip = request.headers.get("CF-Connecting-IP") || "unknown";
	return consume(env.AUTH_RATE_LIMIT, `auth-fail:${ip}`);
}

/**
 * Burn a token from the per-drop-token upload bucket.
 *
 * A drop token is a bearer URL that gets pasted into chats and emails, so it
 * leaks by design. Keying on the token (rather than the IP) means a leaked link
 * is capped no matter how many machines pick it up. The token is hashed first:
 * it is a live credential and should not be handed to another subsystem
 * verbatim.
 */
export async function recordDropTokenUpload(env: Env, token: string): Promise<boolean> {
	return consume(env.UPLOAD_RATE_LIMIT, `drop-token:${(await hashKey(token)).slice(0, 32)}`);
}
