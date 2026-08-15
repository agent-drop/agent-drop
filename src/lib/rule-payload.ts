/**
 * What a delivery actually puts on the wire.
 *
 * Two modes, and the difference is the whole reason `payload_mode` exists:
 *
 *   envelope    -- agent-drop's JSON wrapper. Our body, our content type, our
 *                  `X-Drop-Id` and attempt counter. What every rule sent before
 *                  phase 5, so it stays the default and no existing row changes
 *                  meaning.
 *   passthrough -- the provider's own request, re-sent. Its bytes, its headers,
 *                  its content type, and deliberately NONE of ours. A target
 *                  verifying a Stripe signature has to see exactly what Stripe
 *                  sent, and "exactly" does not survive three extra headers and
 *                  a re-serialized body.
 */

import type { Env, RuleChannel, RuleSubject, WebhookEvent, WebhookQueueMessage } from "../types";
import type { Rule } from "./rule-match";
import { replayableHeaders } from "./webhook-headers";
import { loadStoredBody } from "./webhook-load";

export function parseJsonColumn(raw: string | null | undefined): unknown {
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

/**
 * The JSON wrapper a rule sends under `payload_mode: envelope`.
 *
 * A webhook event gets its own shape rather than being dressed up as a drop. It
 * has no subject, no attachments and no sender -- and it has a slug, a routing
 * key and a verification verdict that no drop has. Pretending otherwise would
 * hand every consumer a `drop` object that is mostly nulls and hide the three
 * fields it actually wanted.
 */
export function envelopeFor(
	subject: RuleSubject,
	rule: Pick<Rule, "id" | "pattern">,
	vars: Record<string, string>,
	channel: RuleChannel,
): Record<string, unknown> {
	const frame = { rule: { id: rule.id, pattern: rule.pattern }, captures: vars };
	if (channel === "hook") {
		return {
			event: "hook.received",
			hook: {
				id: subject.id,
				inbox: subject.inbox,
				slug: subject.slug ?? null,
				event_type: subject.event_type ?? null,
				routing_key: subject.routing_key ?? null,
				method: subject.method ?? null,
				content_type: subject.content_type ?? null,
				body: subject.body_text ?? null,
				body_bytes: subject.body_bytes ?? null,
				body_sha256: subject.body_sha256 ?? null,
				// False when the body was too large or not UTF-8: the bytes are in R2,
				// and `passthrough` or `queue-body` is how you get them.
				body_available: (subject.body_text ?? null) !== null || Boolean(subject.body_r2_key),
				verified: subject.verified ?? null,
				headers: parseJsonColumn(subject.headers),
				query: parseJsonColumn(subject.query),
				created_at: subject.created_at,
			},
			...frame,
		};
	}
	return {
		event: "drop.created",
		drop: {
			id: subject.id,
			inbox: subject.inbox,
			channel: vars.channel,
			topic: subject.topic ?? null,
			subject: subject.subject ?? null,
			from_addr: subject.from_addr ?? null,
			body_text: subject.body_text ?? null,
			has_attachments: subject.has_attachments ?? 0,
			attachment_count: subject.attachment_count ?? 0,
			metadata: subject.metadata ? JSON.parse(subject.metadata) : null,
			created_at: subject.created_at,
		},
		...frame,
	};
}

/**
 * Passthrough re-sends the provider's own request, so it needs a stored event to
 * re-send. A drop has no original bytes -- there was no provider -- so a rule set
 * to passthrough that matches a drop sends the envelope instead of nothing.
 */
export function passthroughApplies(subject: RuleSubject, channel: RuleChannel): boolean {
	return channel === "hook" && Boolean(subject.slug);
}

/**
 * Merge header maps so that a later entry REPLACES an earlier one, whatever case
 * either was written in.
 *
 * A plain object spread cannot do this. `{"User-Agent": "Stripe/1.0"}` and
 * `{"user-agent": "mine"}` are two distinct keys to JavaScript and one header to
 * HTTP, so both survive the spread and `fetch` sends them joined with a comma --
 * `User-Agent: Stripe/1.0, mine`. Nothing errors, the request goes out, and the
 * target sees a header nobody wrote. Header names are case-insensitive on the
 * wire (HTTP/2 requires them lowercase), so folding the case here loses nothing.
 */
function mergeHeaders(...maps: Record<string, string>[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const map of maps) {
		for (const [name, value] of Object.entries(map)) out[name.toLowerCase()] = value;
	}
	return out;
}

/**
 * Resolve one queued message into the request that goes out.
 *
 * A string result is a PERMANENT failure: the bytes this delivery exists to send
 * are not there, and no amount of retrying will produce them.
 */
export async function buildDelivery(
	env: Env,
	wh: WebhookQueueMessage,
	attempt: number,
): Promise<{ headers: Record<string, string>; body: BodyInit } | string> {
	if (wh.mode !== "passthrough") {
		return {
			headers: mergeHeaders(
				{
					"Content-Type": "application/json",
					"User-Agent": "AgentDrop/1.0",
					"X-Drop-Id": wh.dropId,
					// The platform's delivery counter, passed in. The message body cannot
					// carry it: `retry()` re-enqueues the body unchanged.
					"X-Webhook-Attempt": String(attempt),
				},
				wh.headers,
			),
			body: JSON.stringify(wh.payload),
		};
	}

	if (!wh.eventId || !wh.eventInbox) return "passthrough delivery has no source event";
	// Filtered by inbox as well as id, like every other read of an event.
	const event = await env.DB.prepare("SELECT * FROM webhook_events WHERE id = ? AND inbox = ?")
		.bind(wh.eventId, wh.eventInbox)
		.first<WebhookEvent>();
	if (!event) return "passthrough source event no longer exists";

	const stored = await loadStoredBody(env, event);
	if (stored.kind === "gone") return "passthrough source body is no longer stored";

	const original = parseJsonColumn(event.headers) as Record<string, unknown> | null;
	return {
		// The rule's own headers go on last, so a rule can deliberately override one
		// the provider sent -- which is the only way to add an API key for the target.
		headers: mergeHeaders(replayableHeaders(original), wh.headers),
		body: stored.kind === "bytes" ? stored.bytes : "",
	};
}
