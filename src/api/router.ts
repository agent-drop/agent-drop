/**
 * API dispatch.
 *
 * Two ordered route tables, not one. That is not decoration -- it is the
 * behavior:
 *
 *   TIER 1 is reachable without an API key. Each route carries its own gate
 *   (none, admin, admin-or-admin-key, inbox-write, finalize).
 *
 *   Then EVERY remaining request must present a valid API key. A caller with no
 *   credential gets 401 on an unknown path, not 404 -- the key gate runs before
 *   the second table, so an anonymous prober cannot map the API.
 *
 *   TIER 2 routes then only decide what that already-validated key may do.
 *
 * `test/router-routes.test.ts` pins all of this, route by route, and was green
 * against the previous hand-rolled version before this one existed.
 */

import { validateApiKey } from "../lib/auth";
import type { Env } from "../types";
import { handleBoxesList, handleDropsList } from "./admin-lists";
import { corsHeadersFor } from "./cors";
import { handleDrop } from "./drop";
import {
	asAdmin,
	asAdminOrAdminKey,
	asFinalizer,
	asWriter,
	denyCredential,
	type KeyedRoute,
	keyedReader,
	keyedWriter,
	type OpenRoute,
	type RequestScope,
} from "./gates";
import { handleHostDelete, handleHostFinalize, handleHostList, handleHostPresign } from "./host";
import { handleInbox } from "./inbox";
import { handleKeys } from "./keys";
import { handleMasks } from "./masks";
import { exact, type Matcher, prefix, segments, segmentsThenRest } from "./match";
import { handleRules } from "./rules";
import { handleCompose, handleSend, handleSendPresign } from "./send";
import { handleTargets } from "./targets";
import {
	handleConfirm,
	handleMultipartComplete,
	handleMultipartInit,
	handlePresign,
} from "./upload";
import { handleUsers } from "./users";

interface Route<H> {
	/** Undefined means the route ignores the method, which two of them do. */
	method?: string;
	match: Matcher;
	run: H;
}

/** Reachable without an API key; each entry carries its own gate. */
const OPEN_ROUTES: Route<OpenRoute>[] = [
	// Neither of these two checks the method. That predates the table and is
	// pinned by a test rather than quietly corrected here.
	{ match: exact("/api/health"), run: async () => Response.json({ ok: true, ts: Date.now() }) },
	{
		match: exact("/api/config"),
		run: async ({ env }) =>
			Response.json({
				google_client_id: env.GOOGLE_CLIENT_ID_PUBLIC || env.GOOGLE_CLIENT_ID || null,
			}),
	},

	// Admin surface. These match by PREFIX -- each handler sub-routes its own
	// methods and ids -- so `/api/keys/{id}` and `/api/rules/{id}` land here too.
	{
		match: prefix("/api/keys"),
		run: asAdmin(({ request, env, url }) => handleKeys(request, env, url)),
	},
	{
		match: prefix("/api/users"),
		run: asAdmin(({ request, env, url }) => handleUsers(request, env, url)),
	},
	{
		match: prefix("/api/masks"),
		run: asAdmin(({ request, env, url }) => handleMasks(request, env, url)),
	},
	{
		match: prefix("/api/rules"),
		run: asAdmin(({ request, env, url }) => handleRules(request, env, url)),
	},
	{
		match: prefix("/api/deliveries"),
		run: asAdmin(({ request, env, url }) => handleRules(request, env, url)),
	},
	{
		match: prefix("/api/targets"),
		run: asAdmin(({ request, env, url }) => handleTargets(request, env, url)),
	},

	{
		method: "GET",
		match: exact("/api/drops"),
		run: asAdminOrAdminKey(({ env, url }) => handleDropsList(env, url)),
	},
	{
		method: "GET",
		match: exact("/api/boxes"),
		run: asAdminOrAdminKey(({ env }) => handleBoxesList(env)),
	},

	// Writes into a box, by API key, drop token or Google identity.
	{
		method: "POST",
		match: segments("/api/drop/:inbox"),
		run: asWriter((s, inbox, dropCtx) =>
			handleDrop(s.request, s.env, inbox, s.url, dropCtx, s.ctx),
		),
	},
	{
		method: "POST",
		match: segments("/api/upload/presign/:inbox"),
		run: asWriter((s, inbox, dropCtx) => handlePresign(s.request, s.env, inbox, dropCtx)),
	},
	{
		method: "POST",
		match: segments("/api/upload/multipart/:inbox"),
		run: asWriter((s, inbox, dropCtx) => handleMultipartInit(s.request, s.env, inbox, dropCtx)),
	},

	// Finalizing an upload. The inbox comes from the drop row, not the path.
	{
		method: "POST",
		match: exact("/api/upload/complete"),
		run: asFinalizer((s, drop, body) => handleMultipartComplete(s.env, drop, body)),
	},
	{
		method: "POST",
		match: exact("/api/upload/confirm"),
		run: asFinalizer((s, drop) => handleConfirm(s.env, drop)),
	},
];

/** Reached only with a valid API key; the gate decides what that key may do. */
const KEYED_ROUTES: Route<KeyedRoute>[] = [
	{
		method: "POST",
		match: segments("/api/host/presign/:inbox"),
		run: keyedWriter((s, inbox) => handleHostPresign(s.request, s.env, inbox)),
	},
	{
		method: "POST",
		match: segments("/api/host/finalize/:inbox"),
		run: keyedWriter((s, inbox) => handleHostFinalize(s.request, s.env, inbox)),
	},
	{
		method: "DELETE",
		match: segments("/api/host/sites/:inbox/:site"),
		run: keyedWriter((s, inbox, params) => handleHostDelete(s.env, inbox, params.site)),
	},
	{
		method: "GET",
		match: segments("/api/host/sites/:inbox"),
		run: keyedReader((s, inbox) => handleHostList(s.env, inbox)),
	},

	// Outbound mail. `:inbox` becomes the From address, so the same write gate
	// applies here as everywhere else -- see test/send-scope.test.ts for what
	// happened while these three had a copy of it that stopped one line early.
	{
		method: "POST",
		match: segments("/api/send/presign/:inbox"),
		run: keyedWriter((s, inbox) => handleSendPresign(s.request, s.env, inbox)),
	},
	{
		method: "POST",
		match: segments("/api/compose/:inbox"),
		run: keyedWriter((s, inbox) => handleCompose(s.request, s.env, inbox)),
	},
	{
		method: "POST",
		match: segments("/api/send/:inbox"),
		run: keyedWriter((s, inbox) => handleSend(s.request, s.env, inbox)),
	},

	{
		method: "GET",
		match: segmentsThenRest("/api/inbox/:inbox"),
		run: keyedReader((s, inbox, params) => handleInbox(s.env, inbox, params.rest, s.url)),
	},
];

function find<H>(routes: Route<H>[], path: string, method: string) {
	for (const route of routes) {
		if (route.method && route.method !== method) continue;
		const params = route.match(path);
		if (params) return { route, params };
	}
	return null;
}

export async function handleAPI(
	request: Request,
	env: Env,
	url: URL,
	ctx: ExecutionContext,
): Promise<Response> {
	const path = url.pathname;
	const method = request.method;
	const scope: RequestScope = { request, env, url, ctx, cors: corsHeadersFor(env, path) };

	if (method === "OPTIONS") return new Response(null, { headers: scope.cors });

	const open = find(OPEN_ROUTES, path, method);
	if (open) return stamp(await open.route.run(scope, open.params), scope.cors);

	// Everything past here needs a key, INCLUDING paths that match no route --
	// so an anonymous caller cannot tell a real endpoint from a made-up one.
	const auth = await validateApiKey(env, request, ctx);
	if (!auth.valid) {
		return await denyCredential(scope, 401, { error: "invalid api key" });
	}

	const keyed = find(KEYED_ROUTES, path, method);
	if (keyed) return stamp(await keyed.route.run(scope, keyed.params, auth), scope.cors);

	return Response.json({ error: "not found" }, { status: 404, headers: scope.cors });
}

/**
 * Stamp the CORS headers on the way out, once, instead of at every return.
 * A no-op for the routes that get no CORS headers at all, which is most of them.
 */
function stamp(response: Response, headers: Record<string, string>): Response {
	for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
	return response;
}
