/**
 * Slug rotation -- `POST /api/hooks/receivers/:ref/rotate`.
 *
 * For a whole class of providers the URL IS the credential: one webhook address
 * per account, set in their dashboard, no custom headers and no query params. So
 * rotating it has to be as cheap as rotating a secret, and it must not cost
 * history. It does not, because events reference `receiver_id` and never the
 * slug -- the row keeps its id, its counters and every message it ever took.
 *
 * `--grace` is the other half. A dashboard cutover is not instantaneous, and a
 * provider that is still pushing to the old URL while you paste the new one must
 * not be dropped: the old slug keeps answering until the window closes, which the
 * receive path already honours through `previous_slug_expires_at`.
 */

import { normalizeSlug } from "../lib/normalize";
import { generatedSlug, generatedSlugBase, hookUrl } from "../lib/webhook-defs";
import type { Env, WebhookReceiver } from "../types";

interface RotateBody {
	/** An exact new slug. Otherwise the old base name gets a fresh suffix. */
	slug?: string;
	/** How long the old slug keeps answering. 0 (the default) cuts it dead. */
	graceSeconds?: number;
}

export async function rotateSlug(
	request: Request,
	env: Env,
	receiver: WebhookReceiver,
): Promise<Response> {
	let body: RotateBody = {};
	try {
		const text = await request.text();
		if (text) body = JSON.parse(text) as RotateBody;
	} catch {
		return Response.json({ error: "invalid JSON body" }, { status: 400 });
	}

	const next = body.slug
		? normalizeSlug(body.slug)
		: generatedSlug(generatedSlugBase(receiver.slug));
	if (!next) return Response.json({ error: "invalid slug (a-z, 0-9, hyphens)" }, { status: 400 });
	if (next === receiver.slug) {
		return Response.json({ error: "that is already the slug" }, { status: 400 });
	}

	const grace = Math.max(0, Math.trunc(Number(body.graceSeconds ?? 0)) || 0);
	const now = Date.now();
	// No grace means the old URL stops answering the moment this returns, which is
	// what you want when the reason for rotating is that it leaked.
	const previousSlug = grace > 0 ? receiver.slug : null;
	const previousExpires = grace > 0 ? now + grace * 1000 : null;

	try {
		await env.DB.prepare(
			`UPDATE webhook_receivers SET slug = ?, previous_slug = ?, previous_slug_expires_at = ?
			  WHERE id = ?`,
		)
			.bind(next, previousSlug, previousExpires, receiver.id)
			.run();
	} catch (err) {
		if (String(err).includes("UNIQUE")) {
			return Response.json({ error: "that slug is already taken in this box" }, { status: 409 });
		}
		throw err;
	}

	return Response.json({
		id: receiver.id,
		inbox: receiver.inbox,
		slug: next,
		url: hookUrl(env, receiver.inbox, next),
		previous_slug: previousSlug,
		previous_slug_expires_at: previousExpires,
	});
}
