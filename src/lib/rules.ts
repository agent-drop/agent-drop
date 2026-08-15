/**
 * Firing rules: what happens when something lands in a box.
 *
 * The engine has four channels now -- `email`, `web`, `api` and `hook` -- and it
 * takes a `RuleSubject` rather than a `Drop`, which is the one sanctioned change
 * to existing behaviour in the webhook chain. It is a type narrowing, not a
 * behaviour change: a `Drop` satisfies `RuleSubject` unchanged, so every routing
 * decision made before phase 5 is made identically after it.
 *
 * Matching lives in `rule-match.ts`, the wire format in `rule-payload.ts`, and
 * the retrying consumer in `rule-deliver.ts`. Both are re-exported here so
 * `lib/rules` stays the one import anything outside this folder needs.
 */

import type { Env, RuleChannel, RuleSubject } from "../types";
import { generateId } from "./id";
import { findMatchingRules, type Rule, substitute } from "./rule-match";
import { envelopeFor, passthroughApplies } from "./rule-payload";
import { HOOK_PREFIX } from "./webhook-defs";

export { findMatchingRules } from "./rule-match";
export { processWebhookBatch } from "./rule-deliver";

/**
 * Fire every rule that matches the thing that just arrived.
 *
 * The subject is a `RuleSubject`, not a `Drop`: a webhook event is not a drop
 * and never will be, but it wants the same pattern matching, the same retry
 * queue and the same delivery log. Narrowing the parameter is what buys that
 * without a second copy of any of it.
 */
export async function fireRules(
	env: Env,
	ctx: ExecutionContext,
	subject: RuleSubject,
	channel: RuleChannel,
	forwardFn?: (to: string) => Promise<void>,
): Promise<void> {
	const matches = await findMatchingRules(env, subject.inbox, channel);
	if (matches.length === 0) return;

	const baseVars: Record<string, string> = {
		inbox: subject.inbox,
		topic: subject.topic || "",
		from: subject.from_addr || "",
		subject: subject.subject || "",
		drop_id: subject.id,
		channel,
		// Empty for a drop, which has no receiver behind it -- the same answer an
		// unknown variable has always given, rather than a literal `{slug}`.
		slug: subject.slug || "",
		event_type: subject.event_type || "",
		routing_key: subject.routing_key || "",
	};

	for (const { rule, captures } of matches) {
		const vars = { ...baseVars, ...captures };
		const resolvedTarget = substitute(rule.target, vars);

		if (rule.type === "forward" && channel === "email" && forwardFn) {
			// A single forward rule may target a comma-separated list of addresses;
			// each is delivered (and logged) independently.
			const targets = resolvedTarget
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			for (const addr of targets) {
				ctx.waitUntil(executeForward(env, subject, rule, addr, forwardFn));
			}
		} else if (rule.type === "webhook") {
			ctx.waitUntil(enqueueWebhook(env, subject, rule, resolvedTarget, vars, channel));
		}
	}
}

/**
 * Would delivering to this target feed our own receiver?
 *
 * Only asked on the `hook` channel, because that is the only place the loop
 * closes: an event arrives at `/h/{box}/{slug}`, a rule re-delivers it to
 * `/h/{box}/{slug}`, and the copy fires the same rule again -- with 24 hours of
 * retries behind every hop. A drop rule pointed at a receiver makes one event
 * and stops, so it is left alone.
 */
function isSelfDelivery(env: Env, target: string): boolean {
	try {
		const url = new URL(target);
		return url.hostname === env.DOMAIN && url.pathname.startsWith(`/${HOOK_PREFIX}/`);
	} catch {
		// An unparseable target is somebody else's problem -- the delivery attempt
		// reports it far more usefully than a guess here would.
		return false;
	}
}

// Forward: execute inline (CF Email Workers, fast, no retry needed)
async function executeForward(
	env: Env,
	subject: RuleSubject,
	rule: Rule,
	target: string,
	forwardFn: (to: string) => Promise<void>,
): Promise<void> {
	const logId = generateId();

	await env.DB.prepare(
		`INSERT INTO delivery_log (id, drop_id, rule_id, type, target, status, attempts, created_at)
		VALUES (?, ?, ?, 'forward', ?, 'pending', 1, ?)`,
	)
		.bind(logId, subject.id, rule.id, target, Date.now())
		.run();

	try {
		await forwardFn(target);
		await env.DB.prepare(
			"UPDATE delivery_log SET status = 'success', completed_at = ? WHERE id = ?",
		)
			.bind(Date.now(), logId)
			.run();
	} catch (err: any) {
		await env.DB.prepare(
			"UPDATE delivery_log SET status = 'failed', error = ?, completed_at = ? WHERE id = ?",
		)
			.bind(err.message || "unknown error", Date.now(), logId)
			.run();
	}
}

// Webhook: push to queue (retried by queue consumer)
async function enqueueWebhook(
	env: Env,
	subject: RuleSubject,
	rule: Rule,
	target: string,
	vars: Record<string, string>,
	channel: RuleChannel,
): Promise<void> {
	const logId = generateId();
	const now = Date.now();

	// Refused before it is queued, and logged failed rather than retried: 24 hours
	// of exponential backoff against a loop we can see from here would just be a
	// slower way of filling the queue with copies of one event.
	if (channel === "hook" && isSelfDelivery(env, target)) {
		await env.DB.prepare(
			`INSERT INTO delivery_log (id, drop_id, rule_id, type, target, status, error, attempts,
				created_at, completed_at)
			VALUES (?, ?, ?, 'webhook', ?, 'failed', ?, 0, ?, ?)`,
		)
			.bind(
				logId,
				subject.id,
				rule.id,
				target,
				"refused: target is this instance's own webhook receiver (delivery loop)",
				now,
				now,
			)
			.run();
		return;
	}

	const passthrough = rule.payload_mode === "passthrough" && passthroughApplies(subject, channel);

	const customHeaders: Record<string, string> = rule.headers ? JSON.parse(rule.headers) : {};
	for (const [k, v] of Object.entries(customHeaders)) {
		customHeaders[k] = substitute(v, vars);
	}

	// Create delivery log entry
	await env.DB.prepare(
		`INSERT INTO delivery_log (id, drop_id, rule_id, type, target, status, attempts, created_at)
		VALUES (?, ?, ?, 'webhook', ?, 'queued', 0, ?)`,
	)
		.bind(logId, subject.id, rule.id, target, now)
		.run();

	await env.WEBHOOK_QUEUE.send({
		type: "webhook",
		logId,
		dropId: subject.id,
		ruleId: rule.id,
		target,
		// A passthrough message carries no payload: its body is looked up from the
		// stored event at delivery time, because a body may be a megabyte and a queue
		// message may not.
		payload: passthrough ? {} : envelopeFor(subject, rule, vars, channel),
		headers: customHeaders,
		attempt: 0,
		firstAttemptAt: now,
		...(passthrough ? { mode: "passthrough" as const } : {}),
		...(channel === "hook" ? { eventId: subject.id, eventInbox: subject.inbox } : {}),
	});
}
