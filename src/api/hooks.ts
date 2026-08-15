/**
 * Webhook receiver CRUD -- `/api/hooks/receivers`, admin only.
 *
 * Prefix-matched from the Tier-1 table like `/api/rules`, so this handler does
 * its own sub-routing. The queue those receivers fill is a separate surface
 * under `/api/hooks/queue`, reached with an ordinary scoped API key -- see
 * `hook-queue.ts`. Config validation and the public shape of a receiver live in
 * `hook-config.ts`.
 */

import { normalizeInbox, normalizeSlug } from "../lib/normalize";
import { jsonConfig } from "../lib/webhook-body";
import {
	type CreateBody,
	handshakeConfigError,
	methodsForHandshake,
	normalizeMethods,
	planPatch,
	slugFor,
	unsupportedMode,
	view,
} from "./hook-config";
import { rotateSlug } from "./hook-rotate";
import type { Env, WebhookReceiver } from "../types";

const BASE = "/api/hooks/receivers";

function bad(error: string, status = 400): Response {
	return Response.json({ error }, { status });
}

async function byId(env: Env, id: string): Promise<WebhookReceiver | null> {
	return env.DB.prepare("SELECT * FROM webhook_receivers WHERE id = ?")
		.bind(id)
		.first<WebhookReceiver>();
}

/** Accepts a receiver id, or the `box/slug` pair a human actually remembers. */
async function resolve(env: Env, segs: string[]): Promise<WebhookReceiver | null> {
	if (segs.length === 2) {
		const inbox = normalizeInbox(segs[0]);
		const slug = normalizeSlug(segs[1]);
		if (!inbox || !slug) return null;
		return env.DB.prepare("SELECT * FROM webhook_receivers WHERE inbox = ? AND slug = ?")
			.bind(inbox, slug)
			.first<WebhookReceiver>();
	}
	return byId(env, segs[0]);
}

async function create(request: Request, env: Env): Promise<Response> {
	let body: CreateBody;
	try {
		body = (await request.json()) as CreateBody;
	} catch {
		return bad("invalid JSON body");
	}

	const inbox = body.inbox ? normalizeInbox(body.inbox) : null;
	if (!inbox) return bad("valid inbox required");
	const slug = slugFor(body);
	if (!slug) return bad("invalid slug (a-z, 0-9, hyphens)");
	const denied = unsupportedMode(body);
	if (denied) return bad(denied);
	const misconfigured = handshakeConfigError(body.handshakeMode || "none", body.handshakeConfig);
	if (misconfigured) return bad(misconfigured);

	const id = crypto.randomUUID();
	try {
		await env.DB.prepare(
			`INSERT INTO webhook_receivers (
				id, inbox, slug, label, auth_mode, auth_config, handshake_mode, handshake_config,
				preset, extract_config, response_status, response_body, response_content_type,
				allowed_methods, max_body_bytes, retention_days, daily_cap, expires_at, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				id,
				inbox,
				slug,
				body.label ?? null,
				body.authMode || "none",
				body.authConfig ? JSON.stringify(body.authConfig) : null,
				body.handshakeMode || "none",
				body.handshakeConfig ? JSON.stringify(body.handshakeConfig) : null,
				body.preset ?? null,
				body.extract ? JSON.stringify(body.extract) : null,
				body.responseStatus ?? 200,
				body.responseBody ?? null,
				body.responseContentType ?? null,
				methodsForHandshake(normalizeMethods(body.methods), body.handshakeMode),
				body.maxBodyBytes ?? 1_048_576,
				body.retentionDays ?? 120,
				body.dailyCap ?? null,
				body.expiresAt ?? null,
				Date.now(),
			)
			.run();
	} catch (err) {
		if (String(err).includes("UNIQUE")) {
			return bad("receiver already exists for that inbox and slug", 409);
		}
		throw err;
	}

	const row = await byId(env, id);
	return Response.json(row ? view(env, row) : { id, inbox, slug }, { status: 201 });
}

async function list(env: Env, inbox: string | null): Promise<Response> {
	const { results } = inbox
		? await env.DB.prepare(
				"SELECT * FROM webhook_receivers WHERE inbox = ? ORDER BY created_at DESC",
			)
				.bind(inbox)
				.all<WebhookReceiver>()
		: await env.DB.prepare(
				"SELECT * FROM webhook_receivers ORDER BY created_at DESC",
			).all<WebhookReceiver>();
	return Response.json({ receivers: results.map((r) => view(env, r)) });
}

async function update(request: Request, env: Env, receiver: WebhookReceiver): Promise<Response> {
	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return bad("invalid JSON body");
	}

	const plan = planPatch(body);
	if (typeof plan === "string") return bad(plan);
	if (!plan.sets.length) return bad("nothing to update");

	// Validated against the row as it will BE, not as either half of the patch
	// arrives: switching a receiver to `zoom` without a secret and adding the
	// secret in the same breath are both legal, and so is doing them separately.
	const mode = body.handshakeMode !== undefined ? String(body.handshakeMode) : "";
	const nextMode = mode || receiver.handshake_mode || "none";
	const nextConfig =
		body.handshakeConfig !== undefined
			? body.handshakeConfig
			: jsonConfig<Record<string, unknown>>(receiver.handshake_config);
	const misconfigured = handshakeConfigError(nextMode, nextConfig);
	if (misconfigured) return bad(misconfigured);

	// Turning a live receiver into a `meta` one needs GET just as much as creating
	// it that way did, and the patch may not have mentioned methods at all.
	const methodIndex = plan.sets.indexOf("allowed_methods = ?");
	const current = String(
		methodIndex >= 0 ? plan.params[methodIndex] : receiver.allowed_methods || "POST",
	);
	const widened = methodsForHandshake(current, nextMode);
	if (widened !== current) {
		if (methodIndex >= 0) plan.params[methodIndex] = widened;
		else {
			plan.sets.push("allowed_methods = ?");
			plan.params.push(widened);
		}
	}

	await env.DB.prepare(`UPDATE webhook_receivers SET ${plan.sets.join(", ")} WHERE id = ?`)
		.bind(...plan.params, receiver.id)
		.run();

	const row = await byId(env, receiver.id);
	return Response.json(row ? view(env, row) : { updated: receiver.id });
}

/**
 * Delete a receiver. Its events survive by default -- they are an audit trail and
 * reference `receiver_id`, not the slug -- unless `?purge=1` says otherwise, in
 * which case their R2 bodies go too.
 */
async function destroy(env: Env, url: URL, receiver: WebhookReceiver): Promise<Response> {
	let purged = 0;
	if (url.searchParams.get("purge") === "1") {
		const { results } = await env.DB.prepare(
			"SELECT id, body_r2_key FROM webhook_events WHERE receiver_id = ?",
		)
			.bind(receiver.id)
			.all<{ id: string; body_r2_key: string | null }>();
		for (const row of results) {
			if (row.body_r2_key) await env.BUCKET.delete(row.body_r2_key);
		}
		await env.DB.prepare("DELETE FROM webhook_events WHERE receiver_id = ?")
			.bind(receiver.id)
			.run();
		purged = results.length;
	}
	await env.DB.prepare("DELETE FROM webhook_receivers WHERE id = ?").bind(receiver.id).run();
	return Response.json({ deleted: receiver.id, purged });
}

export async function handleHookReceivers(request: Request, env: Env, url: URL): Promise<Response> {
	const method = request.method;
	const segs = url.pathname.slice(BASE.length).split("/").filter(Boolean);

	if (segs.length === 0) {
		if (method === "POST") return create(request, env);
		if (method === "GET") return list(env, null);
		return bad("method not allowed", 405);
	}

	// `{id}/rotate` and `{box}/{slug}/rotate` both work, because the verb is the
	// last segment and everything before it is the same receiver reference the
	// other routes take.
	if (method === "POST" && segs.length >= 2 && segs[segs.length - 1] === "rotate") {
		const receiver = await resolve(env, segs.slice(0, -1));
		if (!receiver) return bad("no such receiver", 404);
		return rotateSlug(request, env, receiver);
	}

	if (segs.length <= 2) {
		const receiver = await resolve(env, segs);
		// A single unmatched segment is a box name, not a missing receiver: `GET
		// /api/hooks/receivers/lisa` lists lisa's, which is what you meant.
		if (!receiver && segs.length === 1 && method === "GET") {
			const inbox = normalizeInbox(segs[0]);
			if (!inbox) return bad("invalid inbox name");
			return list(env, inbox);
		}
		if (!receiver) return bad("no such receiver", 404);
		if (method === "GET") return Response.json(view(env, receiver));
		if (method === "PATCH") return update(request, env, receiver);
		if (method === "DELETE") return destroy(env, url, receiver);
	}

	return bad("method not allowed", 405);
}
