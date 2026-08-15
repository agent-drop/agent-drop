/**
 * What happens to a webhook event AFTER it is safely stored.
 *
 * Everything here runs under `waitUntil`, never in front of the provider's
 * acknowledgement. That is not an optimisation: 17TRACK turns any non-200 into
 * three more copies over the next hundred minutes, so a rule that takes four
 * seconds to fire must not be able to turn one event into four.
 *
 * Two things happen, and only for an event that actually ENTERED THE QUEUE:
 *
 *   - rules fire on the `hook` channel (§8)
 *   - the event is mirrored into `drops`, if the receiver opted in (§14.2)
 *
 * A `rejected` row is not a delivery -- we told the sender no -- and a
 * `handshake` row is evidence that a provider validated its URL, not work. The
 * receive path never calls this for either, and `fanOutEvent` refuses both on
 * its own as well, because "the caller will not do that" is not a guarantee.
 */

import { generateId } from "./id";
import { fireRules } from "./rules";
import type { Env, WebhookEvent, WebhookReceiver } from "../types";

/**
 * Mirror an event into `drops`, so a box's webhook traffic shows up next to its
 * email and uploads.
 *
 * Off by default and nothing depends on it (§14 decision 2). The queue verbs are
 * the real consumption path -- they have crash semantics a `drops` row does not
 * -- so this is a convenience for looking, and it is deliberately one-way.
 *
 * The mirror does NOT fire drop rules. The hook channel already fired for this
 * event; running the `web`/`api` rules over the copy would deliver the same
 * thing twice to anyone with a `scopes: all` rule, and the second copy would be
 * the one wearing the wrong shape.
 */
async function mirrorToDrops(env: Env, event: WebhookEvent): Promise<void> {
	const metadata = JSON.stringify({
		auth_method: "webhook",
		auth_key_name: null,
		hook_event_id: event.id,
		receiver_id: event.receiver_id,
		slug: event.slug,
		event_type: event.event_type,
		routing_key: event.routing_key,
		verified: event.verified,
		body_sha256: event.body_sha256,
		remote_ip: event.remote_ip,
		user_agent: event.user_agent,
		country: event.country,
		city: null,
	});

	await env.DB.prepare(
		`INSERT INTO drops (id, inbox, topic, channel, from_addr, subject, body_text,
			has_attachments, attachment_count, r2_prefix, raw_r2_key, metadata, created_at)
		VALUES (?, ?, ?, 'hook', ?, ?, ?, 0, 0, NULL, ?, ?, ?)`,
	)
		.bind(
			generateId(),
			event.inbox,
			// The routing key is the correlation handle (§3), which is exactly what a
			// topic is for on the drops side.
			event.routing_key,
			`${event.slug}@webhook`,
			event.event_type ?? event.slug,
			event.body_text,
			// A body too large or not UTF-8 lives in R2; pointing at it keeps the
			// mirror from being a dead end for exactly the bodies you most want.
			event.body_r2_key,
			metadata,
			event.created_at,
		)
		.run();
}

/** Fire rules and mirror, in that order, for one accepted event. */
export async function fanOutEvent(
	env: Env,
	ctx: ExecutionContext,
	receiver: WebhookReceiver,
	event: WebhookEvent,
): Promise<void> {
	if (event.status !== "queued") return;

	await fireRules(env, ctx, event, "hook");

	if (receiver.mirror_to_drops) {
		// A mirror that fails must not take the rules with it, and neither may
		// surface to the provider -- it already has its 200.
		await mirrorToDrops(env, event).catch((err: unknown) =>
			console.error(`mirror_to_drops failed for ${event.id}:`, err),
		);
	}
}
