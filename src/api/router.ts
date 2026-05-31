import type { Env } from "../types";
import { handleInbox } from "./inbox";
import { handleDrop, type DropContext } from "./drop";
import { handleSend, handleSendPresign } from "./send";
import { handleKeys } from "./keys";
import { handleTargets, validateDropToken } from "./targets";
import { handleUsers } from "./users";
import { validateApiKey, isAdmin } from "../lib/auth";
import { validateGoogleToken } from "../lib/google-auth";
import { handlePresign, handleMultipartInit, handleMultipartComplete, handleConfirm } from "./upload";
import { normalizeInbox } from "../lib/normalize";
import { handleRules } from "./rules";
import { handleMasks } from "./masks";

export async function handleAPI(
	request: Request,
	env: Env,
	url: URL,
	ctx: ExecutionContext,
): Promise<Response> {
	const path = url.pathname;
	const method = request.method;

	const corsHeaders = {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Authorization, Content-Type",
	};

	if (method === "OPTIONS") {
		return new Response(null, { headers: corsHeaders });
	}

	if (path === "/api/health") {
		return Response.json({ ok: true, ts: Date.now() }, { headers: corsHeaders });
	}

	// Public config (Google client ID for sign-in)
	if (path === "/api/config") {
		return Response.json({
			google_client_id: env.GOOGLE_CLIENT_ID_PUBLIC || env.GOOGLE_CLIENT_ID || null,
		}, { headers: corsHeaders });
	}

	// Admin-only routes
	if (path.startsWith("/api/keys") || path.startsWith("/api/targets") || path.startsWith("/api/users") || path.startsWith("/api/rules") || path.startsWith("/api/deliveries") || path.startsWith("/api/masks")) {
		if (!isAdmin(request, env)) {
			return Response.json({ error: "admin required" }, { status: 403, headers: corsHeaders });
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
		if (!isAdmin(request, env)) {
			// Also allow with API key that has admin permissions
			const auth = await validateApiKey(env, request);
			if (!auth.valid || auth.permissions !== "admin") {
				return Response.json({ error: "admin required" }, { status: 403, headers: corsHeaders });
			}
		}
		const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
		const since = url.searchParams.get("since");
		const channel = url.searchParams.get("channel");

		let query = "SELECT * FROM drops WHERE 1=1";
		const params: (string | number)[] = [];

		if (since) { query += " AND created_at > ?"; params.push(parseInt(since)); }
		if (channel) { query += " AND channel = ?"; params.push(channel); }

		query += " ORDER BY created_at DESC LIMIT ?";
		params.push(limit);

		const { results } = await env.DB.prepare(query).bind(...params).all();
		const res = Response.json({ count: results.length, drops: results });
		addHeaders(res, corsHeaders);
		return res;
	}

	// GET /api/boxes - list all unique inboxes with stats
	if (path === "/api/boxes" && method === "GET") {
		if (!isAdmin(request, env)) {
			const auth = await validateApiKey(env, request);
			if (!auth.valid || auth.permissions !== "admin") {
				return Response.json({ error: "admin required" }, { status: 403, headers: corsHeaders });
			}
		}

		const { results } = await env.DB.prepare(`
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
		`).all();

		// Also get active drop tokens per inbox
		const { results: tokens } = await env.DB.prepare(
			"SELECT inbox, COUNT(*) as active_tokens FROM drop_tokens WHERE expires_at > ? GROUP BY inbox",
		).bind(Date.now()).all();

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
		if (!name) return Response.json(
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
			if (tokenAuth.valid && tokenAuth.inbox === inboxName) {
				return { ctx: { authMethod: "drop_token" } };
			}
			return Response.json({ error: "invalid or expired token" }, { status: 401, headers: corsHeaders });
		}

		const authHeader = request.headers.get("Authorization") || "";
		if (authHeader.startsWith("Google ")) {
			const jwt = authHeader.slice(7);
			const googleAuth = await validateGoogleToken(env, jwt);
			if (googleAuth.valid) {
				return { ctx: { authMethod: "api_key", authKeyName: `google:${googleAuth.email}` } };
			}
			if (googleAuth.denied) {
				return Response.json({ error: "not authorized", email: googleAuth.email }, { status: 403, headers: corsHeaders });
			}
			return Response.json({ error: "invalid google token" }, { status: 401, headers: corsHeaders });
		}

		const auth = await validateApiKey(env, request);
		if (!auth.valid) {
			return Response.json({ error: "invalid api key" }, { status: 401, headers: corsHeaders });
		}
		if (auth.permissions !== "write" && auth.permissions !== "admin") {
			return Response.json({ error: "write permission required" }, { status: 403, headers: corsHeaders });
		}
		return { ctx: { authMethod: "api_key", authKeyName: auth.keyName || undefined } };
	}

	// Drop endpoint (form data upload through Worker)
	const dropMatch = path.match(/^\/api\/drop\/([^/]+)$/);
	if (dropMatch && method === "POST") {
		const inbox = requireInbox(dropMatch[1]);
		if (inbox instanceof Response) return inbox;
		const authResult = await authenticateWrite(inbox);
		if (authResult instanceof Response) { addHeaders(authResult, corsHeaders); return authResult; }
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
		if (authResult instanceof Response) { addHeaders(authResult, corsHeaders); return authResult; }
		const res = await handlePresign(request, env, inbox, authResult.ctx);
		addHeaders(res, corsHeaders);
		return res;
	}

	const multipartMatch = path.match(/^\/api\/upload\/multipart\/([^/]+)$/);
	if (multipartMatch && method === "POST") {
		const inbox = requireInbox(multipartMatch[1]);
		if (inbox instanceof Response) return inbox;
		const authResult = await authenticateWrite(inbox);
		if (authResult instanceof Response) { addHeaders(authResult, corsHeaders); return authResult; }
		const res = await handleMultipartInit(request, env, inbox, authResult.ctx);
		addHeaders(res, corsHeaders);
		return res;
	}

	if (path === "/api/upload/complete" && method === "POST") {
		// Complete doesn't need inbox-level auth - the dropId was already authenticated at presign
		const res = await handleMultipartComplete(request, env);
		addHeaders(res, corsHeaders);
		return res;
	}

	if (path === "/api/upload/confirm" && method === "POST") {
		const res = await handleConfirm(request, env);
		addHeaders(res, corsHeaders);
		return res;
	}

	// All other routes require API key
	const auth = await validateApiKey(env, request);
	if (!auth.valid) {
		return Response.json({ error: "invalid api key" }, { status: 401, headers: corsHeaders });
	}

	const inboxMatch = path.match(/^\/api\/inbox\/([^/]+)(.*)$/);
	const sendPresignMatch = path.match(/^\/api\/send\/presign\/([^/]+)$/);
	const sendMatch = path.match(/^\/api\/send\/([^/]+)$/);

	if (sendPresignMatch && method === "POST") {
		const inboxName = requireInbox(sendPresignMatch[1]);
		if (inboxName instanceof Response) return inboxName;
		if (auth.permissions !== "write" && auth.permissions !== "admin") {
			return Response.json({ error: "write permission required" }, { status: 403, headers: corsHeaders });
		}
		const res = await handleSendPresign(request, env, inboxName);
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
			return Response.json({ error: "write permission required" }, { status: 403, headers: corsHeaders });
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
