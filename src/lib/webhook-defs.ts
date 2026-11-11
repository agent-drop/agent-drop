/**
 * The handful of facts about webhook receivers that both the public receive path
 * and the admin API need. Kept apart from either so the API layer does not have
 * to import the request handler to learn what a URL looks like.
 */

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

export const GENERATED_SLUG_SUFFIX_LENGTH = 26;
export const MAX_WEBHOOK_SLUG_LENGTH = 64;
const SLUG_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * A random slug suffix, so a URL that IS the credential is not guessable. Each
 * Crockford-base32 character carries five unbiased random bits; 26 carry 130.
 */
export function slugSuffix(length = GENERATED_SLUG_SUFFIX_LENGTH): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	return Array.from(bytes, (byte) => SLUG_ALPHABET[byte & 31]).join("");
}

/** Add a generated suffix without ever producing a slug longer than 64 characters. */
export function generatedSlug(base: string): string {
	const suffix = slugSuffix();
	const maxBaseLength = MAX_WEBHOOK_SLUG_LENGTH - suffix.length - 1;
	const boundedBase = base.slice(0, maxBaseLength).replace(/-+$/, "") || "hook";
	return `${boundedBase}-${suffix}`;
}

/** Preserve the chosen name when rotating either a legacy or current generated slug. */
export function generatedSlugBase(slug: string): string {
	return slug.replace(/-(?:[0-9a-z]{6}|[0-9a-z]{26})$/, "") || slug;
}
