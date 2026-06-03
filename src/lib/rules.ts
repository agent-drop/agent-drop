import type { Env, Drop, WebhookQueueMessage } from "../types";
import { generateId } from "./id";

interface Rule {
	id: string;
	pattern: string;
	type: "forward" | "webhook";
	scopes: string;
	target: string;
	headers: string | null;
	enabled: number;
	priority: number;
}

interface RuleMatch {
	rule: Rule;
	captures: Record<string, string>;
}

function matchPattern(
	pattern: string,
	inbox: string,
): { match: boolean; captures: Record<string, string> } {
	if (pattern === "*") {
		return { match: true, captures: { name: inbox } };
	}
	if (pattern === inbox) {
		return { match: true, captures: {} };
	}
	if (pattern.endsWith("-*")) {
		const prefix = pattern.slice(0, -2);
		if (inbox.startsWith(prefix + "-")) {
			return { match: true, captures: { name: inbox.slice(prefix.length + 1) } };
		}
	}
	if (pattern.startsWith("*-")) {
		const suffix = pattern.slice(2);
		if (inbox.endsWith("-" + suffix)) {
			return { match: true, captures: { name: inbox.slice(0, -(suffix.length + 1)) } };
		}
	}
	const starIdx = pattern.indexOf("*");
	if (starIdx > 0 && starIdx < pattern.length - 1) {
		const prefix = pattern.slice(0, starIdx);
		const suffix = pattern.slice(starIdx + 1);
		if (inbox.startsWith(prefix) && inbox.endsWith(suffix)) {
			const captured = inbox.slice(prefix.length, inbox.length - suffix.length);
			if (captured.length > 0) {
				return { match: true, captures: { name: captured } };
			}
		}
	}
	return { match: false, captures: {} };
}

function substitute(template: string, vars: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] || "");
}

export async function findMatchingRules(
	env: Env,
	inbox: string,
	channel: "email" | "web" | "api",
): Promise<RuleMatch[]> {
	const { results } = await env.DB.prepare(
		"SELECT * FROM drop_rules WHERE enabled = 1 ORDER BY priority DESC, created_at ASC",
	).all<Rule>();

	const matches: RuleMatch[] = [];
	for (const rule of results) {
		const { match, captures } = matchPattern(rule.pattern, inbox);
		if (!match) continue;
		const scopes = rule.scopes.split(",").map((s) => s.trim());
		if (!scopes.includes(channel) && !scopes.includes("all")) continue;
		matches.push({ rule, captures });
	}
	return matches;
}

// Fire all matching rules for a drop
export async function fireRules(
	env: Env,
	ctx: ExecutionContext,
	drop: Drop,
	channel: "email" | "web" | "api",
	forwardFn?: (to: string) => Promise<void>,
): Promise<void> {
	const matches = await findMatchingRules(env, drop.inbox, channel);
	if (matches.length === 0) return;

	const baseVars: Record<string, string> = {
		inbox: drop.inbox,
		topic: drop.topic || "",
		from: drop.from_addr || "",
		subject: drop.subject || "",
		drop_id: drop.id,
		channel,
	};

	for (const { rule, captures } of matches) {
		const vars = { ...baseVars, ...captures };
		const resolvedTarget = substitute(rule.target, vars);

		if (rule.type === "forward" && channel === "email" && forwardFn) {
			// A single forward rule may target a comma-separated list of addresses;
			// each is delivered (and logged) independently.
			const targets = resolvedTarget.split(",").map((s) => s.trim()).filter(Boolean);
			for (const addr of targets) {
				ctx.waitUntil(executeForward(env, drop, rule, addr, forwardFn));
			}
		} else if (rule.type === "webhook") {
			ctx.waitUntil(enqueueWebhook(env, drop, rule, resolvedTarget, vars));
		}
	}
}

// Forward: execute inline (CF Email Workers, fast, no retry needed)
async function executeForward(
	env: Env,
	drop: Drop,
	rule: Rule,
	target: string,
	forwardFn: (to: string) => Promise<void>,
): Promise<void> {
	const logId = generateId();

	await env.DB.prepare(
		`INSERT INTO delivery_log (id, drop_id, rule_id, type, target, status, attempts, created_at)
		VALUES (?, ?, ?, 'forward', ?, 'pending', 1, ?)`,
	).bind(logId, drop.id, rule.id, target, Date.now()).run();

	try {
		await forwardFn(target);
		await env.DB.prepare(
			"UPDATE delivery_log SET status = 'success', completed_at = ? WHERE id = ?",
		).bind(Date.now(), logId).run();
	} catch (err: any) {
		await env.DB.prepare(
			"UPDATE delivery_log SET status = 'failed', error = ?, completed_at = ? WHERE id = ?",
		).bind(err.message || "unknown error", Date.now(), logId).run();
	}
}

// Webhook: push to queue (retried by queue consumer)
async function enqueueWebhook(
	env: Env,
	drop: Drop,
	rule: Rule,
	target: string,
	vars: Record<string, string>,
): Promise<void> {
	const logId = generateId();

	const payload = {
		event: "drop.created",
		drop: {
			id: drop.id,
			inbox: drop.inbox,
			channel: vars.channel,
			topic: drop.topic,
			subject: drop.subject,
			from_addr: drop.from_addr,
			body_text: drop.body_text,
			has_attachments: drop.has_attachments,
			attachment_count: drop.attachment_count,
			metadata: drop.metadata ? JSON.parse(drop.metadata) : null,
			created_at: drop.created_at,
		},
		rule: { id: rule.id, pattern: rule.pattern },
		captures: vars,
	};

	const customHeaders: Record<string, string> = rule.headers
		? JSON.parse(rule.headers)
		: {};
	for (const [k, v] of Object.entries(customHeaders)) {
		customHeaders[k] = substitute(v, vars);
	}

	// Create delivery log entry
	await env.DB.prepare(
		`INSERT INTO delivery_log (id, drop_id, rule_id, type, target, status, attempts, created_at)
		VALUES (?, ?, ?, 'webhook', ?, 'queued', 0, ?)`,
	).bind(logId, drop.id, rule.id, target, Date.now()).run();

	// Push to queue
	const message: WebhookQueueMessage = {
		type: "webhook",
		logId,
		dropId: drop.id,
		ruleId: rule.id,
		target,
		payload,
		headers: customHeaders,
		attempt: 0,
		firstAttemptAt: Date.now(),
	};

	await env.WEBHOOK_QUEUE.send(message);
}

// Queue consumer: process webhook deliveries
export async function processWebhookBatch(
	batch: MessageBatch<WebhookQueueMessage>,
	env: Env,
): Promise<void> {
	for (const msg of batch.messages) {
		const wh = msg.body;
		const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

		// Give up after 24h
		if (Date.now() - wh.firstAttemptAt > MAX_AGE_MS) {
			await env.DB.prepare(
				"UPDATE delivery_log SET status = 'failed', error = 'exceeded 24h retry window', completed_at = ? WHERE id = ?",
			).bind(Date.now(), wh.logId).run();
			msg.ack();
			continue;
		}

		try {
			const res = await fetch(wh.target, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"User-Agent": "AgentDrop/1.0",
					"X-Drop-Id": wh.dropId,
					"X-Webhook-Attempt": String(wh.attempt + 1),
					...wh.headers,
				},
				body: JSON.stringify(wh.payload),
			});

			if (res.ok) {
				await env.DB.prepare(
					"UPDATE delivery_log SET status = 'success', status_code = ?, attempts = ?, completed_at = ? WHERE id = ?",
				).bind(res.status, wh.attempt + 1, Date.now(), wh.logId).run();
				msg.ack();
			} else {
				const errBody = await res.text().catch(() => "");
				await env.DB.prepare(
					"UPDATE delivery_log SET status = 'retrying', status_code = ?, error = ?, attempts = ? WHERE id = ?",
				).bind(res.status, `HTTP ${res.status}: ${errBody.slice(0, 500)}`, wh.attempt + 1, wh.logId).run();

				// Exponential backoff: 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, 512s, 1024s (cap at 1200s = 20min)
				const delaySec = Math.min(2 ** (wh.attempt + 1), 1200);
				msg.retry({ delaySeconds: delaySec });
			}
		} catch (err: any) {
			await env.DB.prepare(
				"UPDATE delivery_log SET status = 'retrying', error = ?, attempts = ? WHERE id = ?",
			).bind(err.message || "network error", wh.attempt + 1, wh.logId).run();

			const delaySec = Math.min(2 ** (wh.attempt + 1), 1200);
			msg.retry({ delaySeconds: delaySec });
		}
	}
}
