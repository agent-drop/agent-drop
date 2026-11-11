import { beforeEach, describe, expect, test } from "bun:test";
import { handleEmail } from "../src/email-handler";
import { buildLegacyRelayAddress } from "../src/lib/relay";
import type { Env, RelayQueueMessage } from "../src/types";
import { makeBucket, makeCtx, makeEnv, type TestEnv } from "./helpers/env";

interface IncomingEmail {
	message: ForwardableEmailMessage;
	rejection(): string | null;
}

function incoming(from: string, to: string, subject = "Hello"): IncomingEmail {
	const raw = [
		`From: ${from}`,
		`To: ${to}`,
		`Subject: ${subject}`,
		"Message-ID: <incoming@example.test>",
		"Content-Type: text/plain; charset=UTF-8",
		"",
		"Body text",
	].join("\r\n");
	let rejected: string | null = null;
	return {
		message: {
			from,
			to,
			headers: new Headers({
				subject,
				"message-id": "<incoming@example.test>",
				"in-reply-to": "<previous@example.test>",
				references: "<root@example.test>",
			}),
			raw: new Response(raw).body as ReadableStream<Uint8Array>,
			rawSize: new TextEncoder().encode(raw).byteLength,
			canBeForwarded: true,
			setReject(reason: string) {
				rejected = reason;
			},
			forward: async () => ({ messageId: "unused" }),
			reply: async () => ({ messageId: "unused" }),
		} as ForwardableEmailMessage,
		rejection: () => rejected,
	};
}

describe("authenticated relay reply routing", () => {
	let env: TestEnv;
	let queued: RelayQueueMessage[];

	beforeEach(async () => {
		queued = [];
		env = makeEnv({
			BUCKET: makeBucket(),
			WEBHOOK_QUEUE: {
				send: async (body: RelayQueueMessage) => {
					queued.push(body);
				},
			} as unknown as Env["WEBHOOK_QUEUE"],
		});
		await env.DB.prepare(
			"INSERT INTO email_masks (id, label, active, created_at) VALUES (?, ?, 1, ?)",
		)
			.bind("j-7k9m", "shopping", Date.now())
			.run();
		await env.DB.prepare(
			`INSERT INTO drop_rules (id, pattern, type, scopes, target, enabled, priority, created_at)
			 VALUES ('rule-1', 'j-*', 'relay', 'email', 'owner@example.org', 1, 0, ?)`,
		)
			.bind(Date.now())
			.run();
	});

	test("mints an opaque Reply-To and routes a later reply through its stored destination", async () => {
		const inbound = incoming("sender@example.com", "j-7k9m@drop.test");
		await handleEmail(inbound.message, env, makeCtx());

		expect(inbound.rejection()).toBeNull();
		expect(queued).toHaveLength(1);
		expect(queued[0]).toMatchObject({
			direction: "inbound",
			to: "owner@example.org",
		});
		expect(queued[0].from).toMatch(/^reply\+[0-9a-hjkmnp-tv-z]{26}@drop\.test$/);
		expect(queued[0].rawEmail).toContain(`Reply-To: ${queued[0].from}`);

		const reply = incoming("owner@example.org", queued[0].from, "Re: Hello");
		await handleEmail(reply.message, env, makeCtx());

		expect(reply.rejection()).toBeNull();
		expect(queued).toHaveLength(2);
		expect(queued[1]).toMatchObject({
			direction: "reply",
			from: "j-7k9m@drop.test",
			to: "sender@example.com",
			subject: "Re: Hello",
		});
	});

	test("rejects a guessed opaque route instead of sending or storing it", async () => {
		const forged = incoming("attacker@example.net", "reply+00000000000000000000000000@drop.test");
		await handleEmail(forged.message, env, makeCtx());

		expect(forged.rejection()).toBe("Invalid relay reply address");
		expect(queued).toEqual([]);
		expect(env.DB.raw.query("SELECT COUNT(*) AS count FROM drops").get()).toEqual({ count: 0 });
	});

	test("rejects forgeable sender-bearing routes when compatibility is disabled", async () => {
		const oldAddress = buildLegacyRelayAddress("victim@example.com", "j-7k9m", "drop.test");
		const forged = incoming("attacker@example.net", oldAddress);
		await handleEmail(forged.message, env, makeCtx());

		expect(forged.rejection()).toBe("Invalid relay reply address");
		expect(queued).toEqual([]);
	});

	test("allows old reply addresses only before an explicitly configured cutoff", async () => {
		env.RELAY_LEGACY_REPLY_UNTIL = "2999-01-01T00:00:00Z";
		const oldAddress = buildLegacyRelayAddress("sender@example.com", "j-7k9m", "drop.test");
		const legacyReply = incoming("owner@example.org", oldAddress, "Old thread");
		await handleEmail(legacyReply.message, env, makeCtx());

		expect(legacyReply.rejection()).toBeNull();
		expect(queued).toHaveLength(1);
		expect(queued[0]).toMatchObject({
			direction: "reply",
			to: "sender@example.com",
		});
	});

	test("does not reserve legacy-looking topic addresses that name no active mask", async () => {
		const ordinary = incoming("sender@example.com", "sales_at_team+newsletter@drop.test");
		await handleEmail(ordinary.message, env, makeCtx());

		expect(ordinary.rejection()).toBeNull();
		expect(queued).toEqual([]);
		expect(env.DB.raw.query("SELECT inbox, topic FROM drops").get()).toEqual({
			inbox: "sales-at-team",
			topic: "newsletter",
		});
	});
});
