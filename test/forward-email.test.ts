import { describe, expect, test } from "bun:test";
import { handleEmail } from "../src/email-handler";
import type { Env } from "../src/types";
import { makeEmail, onlyBuilder } from "./helpers/email";
import { makeBucket, makeCtx, makeEnv } from "./helpers/env";
import { incoming } from "./helpers/inbound";

// A forward rule re-sends inbound mail From the box with the original sender in
// Reply-To. That sender used to be the SMTP envelope, which for any ESP is a
// bounce address: replying to a forwarded newsletter or a Google Groups post
// went to the bounce handler. And a CR/LF the sender encoded into the Subject
// reached the Email Sending binding as a raw line break.
async function forwardOf(email: ReturnType<typeof incoming>) {
	const sent = makeEmail();
	const env = makeEnv({ BUCKET: makeBucket(), EMAIL: sent as unknown as Env["EMAIL"] });
	await env.DB.prepare(
		`INSERT INTO drop_rules (id, pattern, type, scopes, target, enabled, priority, created_at)
		 VALUES ('fwd-1', 'lisa', 'forward', 'email', 'owner@example.org', 1, 0, ?)`,
	)
		.bind(Date.now())
		.run();
	const ctx = makeCtx();
	await handleEmail(email.message, env, ctx);
	await ctx.settle();
	return onlyBuilder(sent);
}

describe("forward rule: who a reply goes to, and how the sender is shown", () => {
	test("Reply-To comes from the header From, not the bounce envelope", async () => {
		const builder = await forwardOf(
			incoming("bounce-1@cf-bounce.example", "lisa@drop.test", "Hi", '"Pat" <pat@example.com>'),
		);
		expect(builder.replyTo).toBe("pat@example.com");
		expect(builder.from).toEqual({ name: "Pat (via lisa@drop.test)", email: "lisa@drop.test" });
	});

	test("a header Reply-To wins for the reply, the author still labels the From", async () => {
		const builder = await forwardOf(
			incoming("bounce-1@cf-bounce.example", "lisa@drop.test", "Hi", "pat@example.com", [
				"Reply-To: replies@example.com",
			]),
		);
		expect(builder.replyTo).toBe("replies@example.com");
		expect(builder.from).toEqual({
			name: "pat@example.com (via lisa@drop.test)",
			email: "lisa@drop.test",
		});
	});

	test("no usable header falls back to the envelope", async () => {
		const builder = await forwardOf(incoming("sender@example.com", "lisa@drop.test", "Hi", null));
		expect(builder.replyTo).toBe("sender@example.com");
	});

	test("a CR/LF encoded into the Subject never reaches the binding", async () => {
		const injected = `=?UTF-8?B?${btoa("hi\r\nX-Injected: 1")}?=`;
		const builder = await forwardOf(
			incoming("pat@example.com", "lisa@drop.test", injected, "pat@example.com"),
		);
		expect(builder.subject).not.toMatch(/[\r\n]/);
		expect(builder.subject).toContain("hi");
		expect(builder.subject).toContain("X-Injected: 1");
	});
});
