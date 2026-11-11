/**
 * The handful of facts about webhook receivers that both the public receive path
 * and the admin API need. Kept apart from either so the API layer does not have
 * to import the request handler to learn what a URL looks like.
 */

import { generateId } from "./id";
import { HANDSHAKE_MODES } from "./webhook-handshake";
import { VERIFIER_MODES } from "./webhook-verify";
import type { Env } from "../types";

/** Top-level reserved path prefix for public webhook receivers on the app host. */
export const HOOK_PREFIX = "h";

/**
 * The modes this build can actually honour. The receiver CRUD refuses to register
 * anything else, rather than letting an operator believe a signature is being
 * checked when it is not.
 *
 * Both lists are DERIVED from the dispatch table that implements them rather
 * than typed out again here, so the two cannot drift: a mode that existed only
 * in one of these arrays would be registerable and then never honoured, and one
 * missing from it would be dead code nobody could reach.
 */
export const SUPPORTED_AUTH_MODES = ["none", ...VERIFIER_MODES];

export const SUPPORTED_HANDSHAKE_MODES = ["none", ...HANDSHAKE_MODES];

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
