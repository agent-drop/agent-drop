import { beforeEach, describe, expect, test } from "bun:test";
import wranglerToml from "../wrangler.toml";
import { processRelayMessage, relayBackoffFor, RELAY_MAX_AGE_MS } from "../src/lib/relay";
import type { Env, RelayQueueMessage } from "../src/types";
import { makeEmail } from "./helpers/email";
import { makeEnv, type TestEnv } from "./helpers/env";

interface RetryOptions {
	delaySeconds?: number;
}

interface RecordedMessage extends Message<RelayQueueMessage> {
	readonly acked: number;
	retries: RetryOptions[];
}

function body(overrides: Partial<RelayQueueMessage> = {}): RelayQueueMessage {
	return {
		type: "relay",
		logId: "log-1",
		maskId: "j-7k9m",
		direction: "reply",
		rawEmail: "From: j-7k9m@drop.test\r\nTo: sender@example.com\r\n\r\nHello",
		from: "j-7k9m@drop.test",
		to: "sender@example.com",
		subject: "Hello",
		attempt: 0,
		firstAttemptAt: Date.now(),
		...overrides,
	};
}

function message(payload: RelayQueueMessage, attempts: number): RecordedMessage {
	const retries: RetryOptions[] = [];
	let acked = 0;
	return {
		body: payload,
		attempts,
		get acked() {
			return acked;
		},
		retries,
		ack() {
			acked += 1;
		},
		retry(options?: RetryOptions) {
			retries.push(options ?? {});
		},
	} as unknown as RecordedMessage;
}

describe("relay queue delivery", () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = makeEnv();
		await env.DB.prepare(
			`INSERT INTO delivery_log
				(id, drop_id, rule_id, type, target, status, attempts, created_at)
			 VALUES ('log-1', 'j-7k9m', 'relay:reply', 'relay', 'sender@example.com', 'queued', 0, ?)`,
		)
			.bind(Date.now())
			.run();
	});

	function log(): { status: string; attempts: number; error: string | null } {
		return env.DB.raw
			.query("SELECT status, attempts, error FROM delivery_log WHERE id = 'log-1'")
			.get() as { status: string; attempts: number; error: string | null };
	}

	test("records the platform attempt on successful delivery", async () => {
		const email = makeEmail({ messageId: "sent-1" });
		env.EMAIL = email as unknown as Env["EMAIL"];
		const msg = message(body({ attempt: 99 }), 4);

		await processRelayMessage(msg, env);

		expect(msg.acked).toBe(1);
		expect(msg.retries).toEqual([]);
		expect(log()).toEqual({ status: "success", attempts: 4, error: "cf:sent-1" });
	});

	test("uses Message.attempts for logging and exponential delay", async () => {
		env.EMAIL = makeEmail({
			fail: new Error("mail service unavailable"),
		}) as unknown as Env["EMAIL"];
		const msg = message(body({ attempt: 99 }), 4);

		await processRelayMessage(msg, env);

		expect(msg.acked).toBe(0);
		expect(msg.retries).toEqual([{ delaySeconds: 16 }]);
		expect(log()).toEqual({
			status: "retrying",
			attempts: 4,
			error: "mail service unavailable",
		});
	});

	test("the immutable body counter cannot pin retries at two seconds", async () => {
		env.EMAIL = makeEmail({ fail: new Error("offline") }) as unknown as Env["EMAIL"];
		const msg = message(body({ attempt: 0 }), 11);

		await processRelayMessage(msg, env);

		expect(msg.retries).toEqual([{ delaySeconds: 1200 }]);
		expect(log().attempts).toBe(11);
	});

	test("fails and acknowledges messages once the 24-hour guard is reached", async () => {
		const email = makeEmail();
		env.EMAIL = email as unknown as Env["EMAIL"];
		const msg = message(body({ firstAttemptAt: Date.now() - RELAY_MAX_AGE_MS - 1 }), 82);

		await processRelayMessage(msg, env);

		expect(email.sends).toEqual([]);
		expect(msg.acked).toBe(1);
		expect(msg.retries).toEqual([]);
		expect(log()).toEqual({
			status: "failed",
			attempts: 82,
			error: "exceeded 24h retry window",
		});
	});

	test("the configured retry ceiling lets the backoff reach the age guard", () => {
		let elapsedSeconds = 0;
		for (let attempt = 1; attempt <= 80; attempt++) {
			elapsedSeconds += relayBackoffFor(attempt);
		}
		expect(elapsedSeconds * 1000).toBeLessThan(RELAY_MAX_AGE_MS);
		elapsedSeconds += relayBackoffFor(81);
		expect(elapsedSeconds * 1000).toBeGreaterThan(RELAY_MAX_AGE_MS);

		const queues = wranglerToml.queues as {
			consumers: { queue: string; max_retries: number }[];
		};
		const consumer = queues.consumers.find((item) => item.queue === "agent-drop-webhooks");
		expect(consumer?.max_retries).toBe(82);
	});
});
