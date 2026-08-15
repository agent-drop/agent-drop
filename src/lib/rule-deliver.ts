/**
 * The queue consumer: one attempt per message, logged either way.
 *
 * Exponential backoff to a 20-minute cap, giving up after 24 hours, every
 * attempt written to `delivery_log`. This is the machinery §8 says to reuse
 * rather than rebuild, and phase 5's only change to it is that a message may now
 * carry the provider's original bytes instead of our JSON.
 */

import type { Env, WebhookQueueMessage } from "../types";
import { buildDelivery } from "./rule-payload";

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** 2s, 4s, 8s ... capped at 20 minutes. */
const MAX_BACKOFF_SECONDS = 1200;

function backoffFor(attempt: number): number {
	return Math.min(2 ** attempt, MAX_BACKOFF_SECONDS);
}

/**
 * Which delivery this is -- from the PLATFORM, 1-based.
 *
 * `retry()` re-enqueues the identical message body and there is no way to mutate
 * it, so anything that has to grow between attempts cannot live in the body. The
 * `attempt` field in `WebhookQueueMessage` did, which meant it read 0 on every
 * delivery forever: the documented 2s/4s/8s ladder was 2 seconds flat, about
 * 43,000 requests at a dead target over the 24-hour window instead of ~80, and
 * `delivery_log.attempts` reported 1 throughout so nobody could see it happening.
 *
 * The `?? 1` is for a runtime that does not populate it, not for a caller: a
 * missing counter must read as "first attempt", never as zero.
 */
function attemptOf(msg: { attempts?: number }): number {
	return msg.attempts && msg.attempts > 0 ? msg.attempts : 1;
}

async function finish(env: Env, logId: string, error: string): Promise<void> {
	await env.DB.prepare(
		"UPDATE delivery_log SET status = 'failed', error = ?, completed_at = ? WHERE id = ?",
	)
		.bind(error, Date.now(), logId)
		.run();
}

export async function processWebhookBatch(
	batch: MessageBatch<WebhookQueueMessage>,
	env: Env,
): Promise<void> {
	for (const msg of batch.messages) {
		const wh = msg.body;
		const attempt = attemptOf(msg);

		// Give up after 24h
		if (Date.now() - wh.firstAttemptAt > MAX_AGE_MS) {
			await finish(env, wh.logId, "exceeded 24h retry window");
			msg.ack();
			continue;
		}

		const delivery = await buildDelivery(env, wh, attempt);
		if (typeof delivery === "string") {
			// Not retryable: the bytes this delivery exists to send are gone, so every
			// future attempt fails identically. Fail it now rather than at hour 24.
			await finish(env, wh.logId, delivery);
			msg.ack();
			continue;
		}

		try {
			const res = await fetch(wh.target, {
				method: "POST",
				headers: delivery.headers,
				body: delivery.body,
			});

			if (res.ok) {
				await env.DB.prepare(
					"UPDATE delivery_log SET status = 'success', status_code = ?, attempts = ?, completed_at = ? WHERE id = ?",
				)
					.bind(res.status, attempt, Date.now(), wh.logId)
					.run();
				msg.ack();
			} else {
				const errBody = await res.text().catch(() => "");
				await env.DB.prepare(
					"UPDATE delivery_log SET status = 'retrying', status_code = ?, error = ?, attempts = ? WHERE id = ?",
				)
					.bind(res.status, `HTTP ${res.status}: ${errBody.slice(0, 500)}`, attempt, wh.logId)
					.run();
				msg.retry({ delaySeconds: backoffFor(attempt) });
			}
		} catch (err: any) {
			await env.DB.prepare(
				"UPDATE delivery_log SET status = 'retrying', error = ?, attempts = ? WHERE id = ?",
			)
				.bind(err.message || "network error", attempt, wh.logId)
				.run();
			msg.retry({ delaySeconds: backoffFor(attempt) });
		}
	}
}
