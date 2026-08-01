import type { Env } from "../types";
import { handleInbox } from "./inbox";
import { handleDrop, type DropContext } from "./drop";
import { handleSend, handleSendPresign, handleCompose } from "./send";
import { handleKeys } from "./keys";
import { handleTargets, validateDropToken } from "./targets";
import { handleUsers } from "./users";
import { validateApiKey, isAdmin } from "../lib/auth";
import { validateGoogleToken } from "../lib/google-auth";
import { recordAuthFailure, recordDropTokenUpload } from "../lib/ratelimit";
import {
	handlePresign,
	handleMultipartInit,
	handleMultipartComplete,
	handleConfirm,
	type FinalizeDrop,
} from "./upload";
import { normalizeInbox } from "../lib/normalize";
import { handleRules } from "./rules";
import { handleMasks } from "./masks";
import { handleHostPresign, handleHostFinalize, handleHostList, handleHostDelete } from "./host";

// The only routes a browser ever calls cross-origin. Everything else on /api is
// CLI- and agent-driven over an Authorization header and needs no CORS headers
// at all -- handing them out unconditionally is how
// `Access-Control-Allow-Origin: *` ended up advertising the admin surface to
// every page on the internet.
function isBrowserRoute(path: string): boolean {
	return (
		path === "/api/health" ||
		path === "/api/config" ||
		path.startsWith("/api/drop/") ||
		path.startsWith("/api/upload/")
	);
}

function corsHeadersFor(env: Env, path: string): Record<string, string> {
	if (!isBrowserRoute(path)) return {};
	return {
		// The real origin, not a wildcard: credentials travel on these routes.
		"Access-Control-Allow-Origin": `https://${env.DOMAIN}`,
		"Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Authorization, Content-Type",
	};
}

export async function handleAPI(
	request: Request,
	env: Env,
	url: URL,
	ctx: ExecutionContext,
): Promise<Response> {
	const path = url.pathname;
	const method = request.method;

	const corsHeaders = corsHeadersFor(env, path);

	if (method === "OPTIONS") {
		return new Response(null, { headers: corsHeaders });
	}

	// Every rejected *credential* burns a token from this client's failure bucket;
	// once it is empty the caller gets 429 instead of another guess. Authorization
	// failures on a valid credential (wrong scope, missing permission) are NOT
	// counted -- that is a misconfigured client, not a brute-force attempt, and
	// throttling it would punish the legitimate agent.
	async function denyCredential(status: number, body: Record<string, unknown>): Promise<Response> {
		if (!(await recordAuthFailure(env, request))) {
			return Response.json(
				{ error: "too many failed authentication attempts" },
				{ status: 429, headers: corsHeaders },
			);
		}
		return Response.json(body, { status, headers: corsHeaders });
	}

	if (path === "/api/health") {
		return Response.json({ ok: true, ts: Date.now() }, { headers: corsHeaders });
	}

	// Public config (Google client ID for sign-in)
	if (path === "/api/config") {
		return Response.json(
			{
				google_client_id: env.GOOGLE_CLIENT_ID_PUBLIC || env.GOOGLE_CLIENT_ID || null,
			},
			{ headers: corsHeaders },
		);
	}

	// Admin-only routes
	if (
		path.startsWith("/api/keys") ||
		path.startsWith("/api/targets") ||
		path.startsWith("/api/users") ||
		path.startsWith("/api/rules") ||
		path.startsWith("/api/deliveries") ||
		path.startsWith("/api/masks")
	) {
		if (!(await isAdmin(request, env))) {
			return denyCredential(403, { error: "admin required" });
		}
		const handler = path.startsWith("/api/keys")
			? handleKeys
			: path.startsWith("/api/users")
				? handleUsers
				: path.startsWith("/api/masks")
					? handleMasks
					: path.startsWith("/api/rules") || path.startsWith("/api/deliveries")
						? handleRules
						: handleTargets;
		const res = await handler(request, env, url);
		addHeaders(res, corsHeaders);
		return res;
	}

	// GET /api/drops - list ALL drops across all inboxes (admin only)
	if (path === "/api/drops" && method === "GET") {
		if (!(await isAdmin(request, env))) {
			// Also allow with API key that has admin permissions
			const auth = await validateApiKey(env, request, ctx);
			if (!auth.valid || auth.permissions !== "admin") {
				return denyCredential(403, { error: "admin required" });
			}
		}
		const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
		const since = url.searchParams.get("since");
		const channel = url.searchParams.get("channel");

		let query = "SELECT * FROM drops WHERE 1=1";
		const params: (string | number)[] = [];

		if (since) {
			query += " AND created_at > ?";
			params.push(parseInt(since, 10));
		}
		if (channel) {
			query += " AND channel = ?";
			params.push(channel);
		}

		query += " ORDER BY created_at DESC LIMIT ?";
		params.push(limit);

		// Read-only listing: nearest consistent replica, not the primary. See the
		// note in src/api/inbox.ts for what `first-unconstrained` trades away.
		const { results } = await env.DB.withSession("first-unconstrained")
			.prepare(query)
			.bind(...params)
			.all();
		const res = Response.json({ count: results.length, drops: results });
		addHeaders(res, corsHeaders);
		return res;
	}

	// GET /api/boxes - list all unique inboxes with stats
	if (path === "/api/boxes" && method === "GET") {
		if (!(await isAdmin(request, env))) {
			const auth = await validateApiKey(env, request, ctx);
			if (!auth.valid || auth.permissions !== "admin") {
				return denyCredential(403, { error: "admin required" });
			}
		}

		// Both queries share ONE session, so the token counts cannot come from a
		// replica older than the one the box list came from.
		const boxDb = env.DB.withSession("first-unconstrained");
		const { results } = await boxDb
			.prepare(`
			SELECT
				inbox,
				COUNT(*) as total_drops,
				SUM(attachment_count) as total_files,
				MAX(created_at) as last_drop_at,
				SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) as unread,
				GROUP_CONCAT(DISTINCT channel) as channels
			FROM drops
			GROUP BY inbox
			ORDER BY last_drop_at DESC
		`)
			.all();

		// Also get active drop tokens per inbox
		const { results: tokens } = await boxDb
			.prepare(
				"SELECT inbox, COUNT(*) as active_tokens FROM drop_tokens WHERE expires_at > ? GROUP BY inbox",
			)
			.bind(Date.now())
			.all();

		const tokenMap = new Map(tokens.map((t: any) => [t.inbox, t.active_tokens]));
		const boxes = results.map((r: any) => ({
			...r,
			active_tokens: tokenMap.get(r.inbox) || 0,
		}));

		const res = Response.json({ count: boxes.length, boxes });
		addHeaders(res, corsHeaders);
		return res;
	}

	function requireInbox(raw: string): string | Response {
		const name = normalizeInbox(raw);
		if (!name)
			return Response.json(
				{ error: "invalid inbox name (a-z, 0-9, hyphens, must start with letter)" },
				{ status: 400, headers: corsHeaders },
			);
		return name;
	}

	// Authenticate write requests (drop token, Google JWT, or API key)
	async function authenticateWrite(inboxName: string): Promise<{ ctx: DropContext } | Response> {
		const authParam = url.searchParams.get("auth");
		if (authParam) {
			const tokenAuth = await validateDropToken(env, authParam);
			if (!tokenAuth.valid || tokenAuth.inbox !== inboxName) {
				return denyCredential(401, { error: "invalid or expired token" });
			}
			// A drop link is a bearer URL pasted into chats and emails, so it leaks
			// by design. Cap how fast one can be spent, keyed by the token itself so
			// the cap follows the link rather than the uploader's IP.
			if (!(await recordDropTokenUpload(env, authParam))) {
				return Response.json(
					{ error: "rate limit exceeded for this drop link" },
					{ status: 429, headers: corsHeaders },
				);
			}
			return { ctx: { authMethod: "drop_token" } };
		}

		const authHeader = request.headers.get("Authorization") || "";
		if (authHeader.startsWith("Google ")) {
			const jwt = authHeader.slice(7);
			const googleAuth = await validateGoogleToken(env, jwt);
			if (googleAuth.valid) {
				return { ctx: { authMethod: "api_key", authKeyName: `google:${googleAuth.email}` } };
			}
			if (googleAuth.denied) {
				// A real Google identity that is not on the allowlist: authenticated,
				// just not authorized. Not a guess, so it does not burn a token.
				return Response.json(
					{ error: "not authorized", email: googleAuth.email },
					{ status: 403, headers: corsHeaders },
				);
			}
			return denyCredential(401, { error: "invalid google token" });
		}

		const auth = await validateApiKey(env, request, ctx);
		if (!auth.valid) {
			return denyCredential(401, { error: "invalid api key" });
		}
		if (auth.permissions !== "write" && auth.permissions !== "admin") {
			return Response.json(
				{ error: "write permission required" },
				{ status: 403, headers: corsHeaders },
			);
		}
		if (auth.inboxScope && auth.inboxScope !== inboxName) {
			return Response.json({ error: "inbox not in scope" }, { status: 403, headers: corsHeaders });
		}
		return { ctx: { authMethod: "api_key", authKeyName: auth.keyName || undefined } };
	}

	// Drop endpoint (form data upload through Worker)
	const dropMatch = path.match(/^\/api\/drop\/([^/]+)$/);
	if (dropMatch && method === "POST") {
		const inbox = requireInbox(dropMatch[1]);
		if (inbox instanceof Response) return inbox;
		const authResult = await authenticateWrite(inbox);
		if (authResult instanceof Response) {
			addHeaders(authResult, corsHeaders);
			return authResult;
		}
		const res = await handleDrop(request, env, inbox, url, authResult.ctx, ctx);
		addHeaders(res, corsHeaders);
		return res;
	}

	// Presigned upload endpoints (direct-to-R2)
	const presignMatch = path.match(/^\/api\/upload\/presign\/([^/]+)$/);
	if (presignMatch && method === "POST") {
		const inbox = requireInbox(presignMatch[1]);
		if (inbox instanceof Response) return inbox;
		const authResult = await authenticateWrite(inbox);
		if (authResult instanceof Response) {
			addHeaders(authResult, corsHeaders);
			return authResult;
		}
		const res = await handlePresign(request, env, inbox, authResult.ctx);
		addHeaders(res, corsHeaders);
		return res;
	}

	const multipartMatch = path.match(/^\/api\/upload\/multipart\/([^/]+)$/);
	if (multipartMatch && method === "POST") {
		const inbox = requireInbox(multipartMatch[1]);
		if (inbox instanceof Response) return inbox;
		const authResult = await authenticateWrite(inbox);
		if (authResult instanceof Response) {
			addHeaders(authResult, corsHeaders);
			return authResult;
		}
		const res = await handleMultipartInit(request, env, inbox, authResult.ctx);
		addHeaders(res, corsHeaders);
		return res;
	}

	// Finalizing an upload used to run with NO auth at all: the router assumed
	// "the dropId was already authenticated at presign", but nothing re-checked
	// the caller, so anyone who learned a drop id could flip it to `completed` and
	// publish it to every agent reading that inbox. The drop row is the authority
	// on which inbox is being written to -- recover it and re-run the same write
	// auth the presign required.
	async function authenticateFinalize(): Promise<
		{ drop: FinalizeDrop; body: { uploadId?: string } } | Response
	> {
		let body: { dropId?: string; uploadId?: string };
		try {
			body = (await request.json()) as { dropId?: string; uploadId?: string };
		} catch {
			return Response.json({ error: "invalid JSON body" }, { status: 400, headers: corsHeaders });
		}
		if (!body?.dropId) {
			return Response.json({ error: "dropId required" }, { status: 400, headers: corsHeaders });
		}

		const drop = await env.DB.prepare(
			"SELECT id, inbox, r2_prefix, object_key, subject, status FROM drops WHERE id = ?",
		)
			.bind(body.dropId)
			.first<FinalizeDrop>();
		if (!drop) {
			return Response.json({ error: "drop not found" }, { status: 404, headers: corsHeaders });
		}

		const authResult = await authenticateWrite(drop.inbox);
		if (authResult instanceof Response) return authResult;
		return { drop, body };
	}

	if ((path === "/api/upload/complete" || path === "/api/upload/confirm") && method === "POST") {
		const finalize = await authenticateFinalize();
		if (finalize instanceof Response) {
			addHeaders(finalize, corsHeaders);
			return finalize;
		}
		const res =
			path === "/api/upload/complete"
				? await handleMultipartComplete(env, finalize.drop, finalize.body)
				: await handleConfirm(env, finalize.drop);
		addHeaders(res, corsHeaders);
		return res;
	}

	// All other routes require API key
	const auth = await validateApiKey(env, request, ctx);
	if (!auth.valid) {
		return denyCredential(401, { error: "invalid api key" });
	}

	const inboxMatch = path.match(/^\/api\/inbox\/([^/]+)(.*)$/);
	const sendPresignMatch = path.match(/^\/api\/send\/presign\/([^/]+)$/);
	const sendMatch = path.match(/^\/api\/send\/([^/]+)$/);
	const composeMatch = path.match(/^\/api\/compose\/([^/]+)$/);
	const hostPresignMatch = path.match(/^\/api\/host\/presign\/([^/]+)$/);
	const hostFinalizeMatch = path.match(/^\/api\/host\/finalize\/([^/]+)$/);
	const hostSiteMatch = path.match(/^\/api\/host\/sites\/([^/]+)\/([^/]+)$/);
	const hostListMatch = path.match(/^\/api\/host\/sites\/([^/]+)$/);

	function requireWriteScope(inbox: string): Response | null {
		if (auth.permissions !== "write" && auth.permissions !== "admin") {
			return Response.json(
				{ error: "write permission required" },
				{ status: 403, headers: corsHeaders },
			);
		}
		if (auth.inboxScope && auth.inboxScope !== inbox) {
			return Response.json({ error: "inbox not in scope" }, { status: 403, headers: corsHeaders });
		}
		return null;
	}

	if (hostPresignMatch && method === "POST") {
		const inbox = requireInbox(hostPresignMatch[1]);
		if (inbox instanceof Response) return inbox;
		const denied = requireWriteScope(inbox);
		if (denied) return denied;
		const res = await handleHostPresign(request, env, inbox);
		addHeaders(res, corsHeaders);
		return res;
	}

	if (hostFinalizeMatch && method === "POST") {
		const inbox = requireInbox(hostFinalizeMatch[1]);
		if (inbox instanceof Response) return inbox;
		const denied = requireWriteScope(inbox);
		if (denied) return denied;
		const res = await handleHostFinalize(request, env, inbox);
		addHeaders(res, corsHeaders);
		return res;
	}

	if (hostSiteMatch && method === "DELETE") {
		const inbox = requireInbox(hostSiteMatch[1]);
		if (inbox instanceof Response) return inbox;
		const denied = requireWriteScope(inbox);
		if (denied) return denied;
		const res = await handleHostDelete(env, inbox, hostSiteMatch[2]);
		addHeaders(res, corsHeaders);
		return res;
	}

	if (hostListMatch && method === "GET") {
		const inbox = requireInbox(hostListMatch[1]);
		if (inbox instanceof Response) return inbox;
		if (auth.inboxScope && auth.inboxScope !== inbox) {
			return Response.json({ error: "inbox not in scope" }, { status: 403, headers: corsHeaders });
		}
		const res = await handleHostList(env, inbox);
		addHeaders(res, corsHeaders);
		return res;
	}

	if (sendPresignMatch && method === "POST") {
		const inboxName = requireInbox(sendPresignMatch[1]);
		if (inboxName instanceof Response) return inboxName;
		if (auth.permissions !== "write" && auth.permissions !== "admin") {
			return Response.json(
				{ error: "write permission required" },
				{ status: 403, headers: corsHeaders },
			);
		}
		const res = await handleSendPresign(request, env, inboxName);
		addHeaders(res, corsHeaders);
		return res;
	}

	if (composeMatch && method === "POST") {
		const inboxName = requireInbox(composeMatch[1]);
		if (inboxName instanceof Response) return inboxName;
		if (auth.permissions !== "write" && auth.permissions !== "admin") {
			return Response.json(
				{ error: "write permission required" },
				{ status: 403, headers: corsHeaders },
			);
		}
		const res = await handleCompose(request, env, inboxName);
		addHeaders(res, corsHeaders);
		return res;
	}

	if (inboxMatch && method === "GET") {
		const inbox = requireInbox(inboxMatch[1]);
		if (inbox instanceof Response) return inbox;
		const subPath = inboxMatch[2] || "";
		if (auth.inboxScope && auth.inboxScope !== inbox) {
			return Response.json({ error: "inbox not in scope" }, { status: 403, headers: corsHeaders });
		}
		const res = await handleInbox(env, inbox, subPath, url);
		addHeaders(res, corsHeaders);
		return res;
	}

	if (sendMatch && method === "POST") {
		const inboxName = requireInbox(sendMatch[1]);
		if (inboxName instanceof Response) return inboxName;
		if (auth.permissions !== "write" && auth.permissions !== "admin") {
			return Response.json(
				{ error: "write permission required" },
				{ status: 403, headers: corsHeaders },
			);
		}
		const res = await handleSend(request, env, inboxName);
		addHeaders(res, corsHeaders);
		return res;
	}

	return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders });
}

function addHeaders(response: Response, headers: Record<string, string>) {
	for (const [key, value] of Object.entries(headers)) {
		response.headers.set(key, value);
	}
}
