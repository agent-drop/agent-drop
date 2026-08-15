/**
 * The handful of facts about webhook receivers that both the public receive path
 * and the admin API need. Kept apart from either so the API layer does not have
 * to import the request handler to learn what a URL looks like.
 */

import { generateId } from "./id";
import type { Env } from "../types";

/** Top-level reserved path prefix, beside `/f/` for hosting. In run_worker_first. */
export const HOOK_PREFIX = "h";

/**
 * The modes this build can actually honour. Phase 2 adds the verifiers and
 * phase 3 the handshakes; until then the receiver CRUD refuses to register a
 * mode nothing implements, rather than letting an operator believe a signature
 * is being checked when it is not.
 */
export const SUPPORTED_AUTH_MODES = ["none"];
export const SUPPORTED_HANDSHAKE_MODES = ["none"];

export function hookUrl(env: Env, inbox: string, slug: string): string {
	return `https://${env.DOMAIN}/${HOOK_PREFIX}/${inbox}/${slug}`;
}

/**
 * A random slug suffix, so a URL that IS the credential is not guessable.
 *
 * Six characters of the id alphabet is ~30 bits. That is fine behind the
 * per-receiver rate limit, which is what actually stops enumeration -- raise it
 * when a receiver is the sole credential for something that matters.
 */
export function slugSuffix(length = 6): string {
	return generateId().slice(-length);
}
