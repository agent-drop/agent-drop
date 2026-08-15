/**
 * `POST /api/hooks/queue/:box/:id/replay` -- re-deliver a stored event through
 * the machinery that delivers everything else.
 *
 * There are TWO replays in this CLI and they are not the same thing:
 *
 *   queue-replay  is CLIENT side. The CLI fetches the event and its bytes and
 *                 POSTs them itself, once, from wherever you are sitting. No
 *                 retries, no log, no server involvement past two reads. It is
 *                 the debugging verb: does my endpoint accept this payload?
 *
 *   hook-replay   is SERVER side, and this is it. The delivery is queued, so it
 *                 gets the exponential backoff, the 24-hour give-up and the
 *                 `delivery_log` row that a rule-fired delivery gets. It is the
 *                 operational verb: my consumer was down for an hour, send it
 *                 again properly.
 *
 * Both are kept because they answer different questions, and the `--help` text
 * of each says which is which.
 */

import { generateId } from "../lib/id";
import { envelopeFor } from "../lib/rule-payload";
import { fireRules } from "../lib/rules";
import { readJson } from "./hook-lease";
import type { Env, WebhookEvent } from "../types";

interface ReplayBody {
	/** Deliver to exactly this URL. Omit to re-fire whatever rules match. */
	to?: string;
	mode?: string;
	/** Extra headers for a `--to` delivery; they override the stored ones. */
	headers?: Record<string, string>;
}

/**
 * Queue one already-decided delivery: one target, one mode, no pattern matching.
 *
 * Deliberately the same queue, backoff and log as a rule-fired delivery. A
 * replay that took a shortcut would be a replay of something other than what
 * production does, which is the one thing it must not be.
 */
async function enqueueReplay(
	env: Env,
	event: WebhookEvent,
	target: string,
	mode: "envelope" | "passthrough",
	headers: Record<string, string>,
): Promise<string> {
	const logId = generateId();
	const now = Date.now();
	// A replay has no rule, but `delivery_log.rule_id` is NOT NULL -- and a
	// synthetic id that says what it is beats a real rule's id that never fired.
	const ruleId = "replay";
	const vars: Record<string, string> = {
		inbox: event.inbox,
		channel: "hook",
		drop_id: event.id,
		slug: event.slug,
		event_type: event.event_type ?? "",
		routing_key: event.routing_key ?? "",
	};

	await env.DB.prepare(
		`INSERT INTO delivery_log (id, drop_id, rule_id, type, target, status, attempts, created_at)
		VALUES (?, ?, ?, 'webhook', ?, 'queued', 0, ?)`,
	)
		.bind(logId, event.id, ruleId, target, now)
		.run();

	await env.WEBHOOK_QUEUE.send({
		type: "webhook",
		logId,
		dropId: event.id,
		ruleId,
		target,
		payload:
			mode === "passthrough"
				? {}
				: envelopeFor(event, { id: ruleId, pattern: "(replay)" }, vars, "hook"),
		headers,
		attempt: 0,
		firstAttemptAt: now,
		...(mode === "passthrough" ? { mode: "passthrough" as const } : {}),
		eventId: event.id,
		eventInbox: event.inbox,
	});

	return logId;
}

export async function handleHookReplay(
	request: Request,
	env: Env,
	inbox: string,
	id: string,
): Promise<Response> {
	const body = (await readJson<ReplayBody>(request)) ?? {};

	// Filtered by inbox as well as id, like every other read of an event.
	const event = await env.DB.prepare("SELECT * FROM webhook_events WHERE id = ? AND inbox = ?")
		.bind(id, inbox)
		.first<WebhookEvent>();
	if (!event) return Response.json({ error: "no such event" }, { status: 404 });

	// A handshake is the record of a provider validating its URL -- there is
	// nothing to deliver, and a consumer handed one would be handed a lie about
	// what it is. A rejected event is a refusal we already answered 401 to; requeue
	// it deliberately if you have fixed the secret, and it will replay then.
	if (event.status === "handshake" || event.status === "rejected") {
		return Response.json(
			{ error: `a ${event.status} event is not a delivery and is never replayed` },
			{ status: 409 },
		);
	}

	if (body.mode && body.mode !== "envelope" && body.mode !== "passthrough") {
		return Response.json({ error: "mode must be 'envelope' or 'passthrough'" }, { status: 400 });
	}
	const mode = body.mode === "passthrough" ? "passthrough" : "envelope";

	if (body.to) {
		let target: URL;
		try {
			target = new URL(body.to);
		} catch {
			return Response.json({ error: "to must be an absolute URL" }, { status: 400 });
		}
		if (target.protocol !== "http:" && target.protocol !== "https:") {
			return Response.json({ error: "to must be http or https" }, { status: 400 });
		}
		const logId = await enqueueReplay(env, event, target.toString(), mode, body.headers ?? {});
		return Response.json({ replayed: event.id, target: target.toString(), mode, delivery: logId });
	}

	// No explicit target: re-run the rules this event would have fired. Useful
	// after adding or fixing a rule that did not exist when the event landed.
	//
	// `fireRules` defers its work to `waitUntil` because on the receive path the
	// provider is waiting. Nobody is waiting here, and an operator who asked for a
	// replay wants to be told what it queued -- so the deferred work is collected
	// and awaited instead of being handed to the request's own context, where the
	// log query below would race it and usually report nothing.
	const pending: Promise<unknown>[] = [];
	const collector = {
		waitUntil: (p: Promise<unknown>) => {
			pending.push(p);
		},
		passThroughOnException: () => {},
	} as unknown as ExecutionContext;
	await fireRules(env, collector, event, "hook");
	await Promise.allSettled(pending);

	const { results } = await env.DB.prepare(
		`SELECT id, rule_id, target, status FROM delivery_log
		  WHERE drop_id = ? ORDER BY created_at DESC LIMIT 20`,
	)
		.bind(event.id)
		.all<{ id: string; rule_id: string; target: string; status: string }>();

	return Response.json({ replayed: event.id, mode: "rules", deliveries: results });
}
