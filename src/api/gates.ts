/**
 * The authorization gates the route tables compose from.
 *
 * Before phase 6 each of these was inline in the dispatcher, and the
 * write-permission-plus-scope check in particular was pasted at four call sites
 * -- which is how one of them came to be subtly different from the others.
 * A gate lives once, here, and a route names the one it wants.
 */

import { isAdmin, validateApiKey } from "../lib/auth";
import { parseJsonObject, readRequestCapped } from "../lib/body-limit";
import { validateGoogleToken } from "../lib/google-auth";
import { normalizeInbox } from "../lib/normalize";
import { recordAuthFailure, recordDropTokenUpload } from "../lib/ratelimit";
import type { FinalizeDrop } from "../lib/drops";
import type { Env } from "../types";
import type { DropContext } from "./drop";
import type { Params } from "./match";
import { validateDropToken } from "./targets";

/** Everything a route or gate needs about the request in flight. */
export interface RequestScope {
	request: Request;
	env: Env;
	url: URL;
	ctx: ExecutionContext;
	/** CORS headers for this path -- empty for everything that is not browser-reachable. */
	cors: Record<string, string>;
}

/** What `validateApiKey` hands back once it has said yes. */
export type KeyAuth = Awaited<ReturnType<typeof validateApiKey>>;

/** A route in the first tier: reached before any API key is required. */
export type OpenRoute = (scope: RequestScope, params: Params) => Promise<Response>;

/** A route in the second tier: an API key was already validated. */
export type KeyedRoute = (scope: RequestScope, params: Params, auth: KeyAuth) => Promise<Response>;

function reject(scope: RequestScope, status: number, body: Record<string, unknown>): Response {
	return Response.json(body, { status, headers: scope.cors });
}

/**
 * Reject a bad *credential*, burning a token from this client's failure bucket;
 * once it is empty the caller gets 429 instead of another guess.
 *
 * Authorization failures on a VALID credential (wrong scope, missing
 * permission) deliberately do not come through here -- that is a misconfigured
 * client, not a brute-force attempt, and throttling it punishes the legitimate
 * agent.
 */
export async function denyCredential(
	scope: RequestScope,
	status: number,
	body: Record<string, unknown>,
): Promise<Response> {
	if (!(await recordAuthFailure(scope.env, scope.request))) {
		return reject(scope, 429, { error: "too many failed authentication attempts" });
	}
	return reject(scope, status, body);
}

/** Normalize a path segment into an inbox name, or 400. */
export function requireInbox(scope: RequestScope, raw: string): string | Response {
	const name = normalizeInbox(raw);
	if (!name) {
		return reject(scope, 400, {
			error: "invalid inbox name (a-z, 0-9, hyphens, must start with letter)",
		});
	}
	return name;
}

/** Authenticate a write to `inboxName`: drop token, Google JWT, or API key. */
export async function authenticateWrite(
	scope: RequestScope,
	inboxName: string,
): Promise<{ ctx: DropContext } | Response> {
	const { env, request, url } = scope;

	const authParam = url.searchParams.get("auth");
	if (authParam) {
		const tokenAuth = await validateDropToken(env, authParam);
		if (!tokenAuth.valid || tokenAuth.inbox !== inboxName) {
			return denyCredential(scope, 401, { error: "invalid or expired token" });
		}
		// A drop link is a bearer URL pasted into chats and emails, so it leaks by
		// design. Cap how fast one can be spent, keyed by the token itself so the
		// cap follows the link rather than the uploader's IP.
		if (!(await recordDropTokenUpload(env, authParam))) {
			return reject(scope, 429, { error: "rate limit exceeded for this drop link" });
		}
		return { ctx: { authMethod: "drop_token" } };
	}

	const authHeader = request.headers.get("Authorization") || "";
	if (authHeader.startsWith("Google ")) {
		const googleAuth = await validateGoogleToken(env, authHeader.slice(7));
		if (googleAuth.valid) {
			return { ctx: { authMethod: "api_key", authKeyName: `google:${googleAuth.email}` } };
		}
		if (googleAuth.denied) {
			// A real Google identity that is not on the allowlist: authenticated,
			// just not authorized. Not a guess, so it does not burn a token.
			return reject(scope, 403, { error: "not authorized", email: googleAuth.email });
		}
		return denyCredential(scope, 401, { error: "invalid google token" });
	}

	const auth = await validateApiKey(env, request, scope.ctx);
	if (!auth.valid) {
		return denyCredential(scope, 401, { error: "invalid api key" });
	}
	const denied = requireWriteScope(scope, auth, inboxName);
	if (denied) return denied;
	return { ctx: { authMethod: "api_key", authKeyName: auth.keyName || undefined } };
}

/** A validated key may write to `inbox`: right permission AND right scope. */
export function requireWriteScope(
	scope: RequestScope,
	auth: KeyAuth,
	inbox: string,
): Response | null {
	if (auth.permissions !== "write" && auth.permissions !== "admin") {
		return reject(scope, 403, { error: "write permission required" });
	}
	return requireScope(scope, auth, inbox);
}

/** A validated key is allowed to touch `inbox` at all. */
export function requireScope(scope: RequestScope, auth: KeyAuth, inbox: string): Response | null {
	if (auth.inboxScope && auth.inboxScope !== inbox) {
		return reject(scope, 403, { error: "inbox not in scope" });
	}
	return null;
}

// ---------------------------------------------------------------------------
// Route wrappers. Each takes the handler and returns a route with the gate in
// front of it, so a table entry names its gate instead of restating it.
// ---------------------------------------------------------------------------

/** The master admin credential only. */
export function asAdmin(handle: OpenRoute): OpenRoute {
	return async (scope, params) => {
		if (!(await isAdmin(scope.request, scope.env))) {
			return denyCredential(scope, 403, { error: "admin required" });
		}
		return handle(scope, params);
	};
}

/** The master admin credential, or an API key carrying admin permissions. */
export function asAdminOrAdminKey(
	handle: (scope: RequestScope, params: Params, inboxScope: string | null) => Promise<Response>,
): OpenRoute {
	return async (scope, params) => {
		if (await isAdmin(scope.request, scope.env)) {
			return handle(scope, params, null);
		}

		const auth = await validateApiKey(scope.env, scope.request, scope.ctx);
		if (!auth.valid || auth.permissions !== "admin") {
			return denyCredential(scope, 403, { error: "admin required" });
		}
		return handle(scope, params, auth.inboxScope);
	};
}

/**
 * Normalize `:inbox`, then authenticate a write to it by any of the three
 * credential kinds. The handler receives the normalized name and the
 * DropContext describing which credential got in.
 */
export function asWriter(
	handle: (scope: RequestScope, inbox: string, dropCtx: DropContext) => Promise<Response>,
): OpenRoute {
	return async (scope, params) => {
		const inbox = requireInbox(scope, params.inbox);
		if (inbox instanceof Response) return inbox;
		const auth = await authenticateWrite(scope, inbox);
		if (auth instanceof Response) return auth;
		return handle(scope, inbox, auth.ctx);
	};
}

/**
 * Load the drop being finalized and re-run the write auth its presign required.
 *
 * Finalizing used to run with NO auth at all, on the theory that "the dropId was
 * already authenticated at presign" -- but nothing re-checked the caller, so
 * anyone who learned a drop id could flip it to `completed` and publish it to
 * every agent reading that inbox. The drop ROW is the authority on which inbox
 * is being written to.
 */
/** `{dropId, uploadId}` and nothing else; an R2 upload id is a few hundred bytes. */
export const MAX_FINALIZE_BODY_BYTES = 16 * 1024;

export function asFinalizer(
	handle: (
		scope: RequestScope,
		drop: FinalizeDrop,
		body: { uploadId?: string },
	) => Promise<Response>,
): OpenRoute {
	return async (scope) => {
		// Bounded BEFORE the lookup: this runs ahead of any credential check, so an
		// unbounded read would let anyone make the Worker buffer a huge body.
		const bytes = await readRequestCapped(scope.request, MAX_FINALIZE_BODY_BYTES, "request body");
		if (bytes instanceof Response) return bytes;
		const parsed = parseJsonObject(bytes);
		if (!parsed) return reject(scope, 400, { error: "invalid JSON body" });
		const body = parsed as { dropId?: string; uploadId?: string };
		if (typeof body.dropId !== "string" || !body.dropId) {
			return reject(scope, 400, { error: "dropId required" });
		}

		const drop = await scope.env.DB.prepare(
			"SELECT id, inbox, r2_prefix, object_key, subject, status FROM drops WHERE id = ?",
		)
			.bind(body.dropId)
			.first<FinalizeDrop>();
		if (!drop) return reject(scope, 404, { error: "drop not found" });

		const auth = await authenticateWrite(scope, drop.inbox);
		if (auth instanceof Response) return auth;
		return handle(scope, drop, body);
	};
}

/** Second tier: normalize `:inbox` and require write permission plus scope. */
export function keyedWriter(
	handle: (scope: RequestScope, inbox: string, params: Params) => Promise<Response>,
): KeyedRoute {
	return async (scope, params, auth) => {
		const inbox = requireInbox(scope, params.inbox);
		if (inbox instanceof Response) return inbox;
		const denied = requireWriteScope(scope, auth, inbox);
		if (denied) return denied;
		return handle(scope, inbox, params);
	};
}

/** Second tier: normalize `:inbox` and require only that it is in scope. */
export function keyedReader(
	handle: (scope: RequestScope, inbox: string, params: Params) => Promise<Response>,
): KeyedRoute {
	return async (scope, params, auth) => {
		const inbox = requireInbox(scope, params.inbox);
		if (inbox instanceof Response) return inbox;
		const denied = requireScope(scope, auth, inbox);
		if (denied) return denied;
		return handle(scope, inbox, params);
	};
}
