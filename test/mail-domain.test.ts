import { describe, expect, test } from "bun:test";
import { handleSend } from "../src/api/send";
import { siteUrl } from "../src/lib/hosting";
import { forwardViaBinding } from "../src/lib/relay";
import { hookUrl } from "../src/lib/webhook-defs";
import type { Env } from "../src/types";
import { makeEmail, onlyBuilder } from "./helpers/email";
import { jsonRequest, makeEnv, TEST_DOMAIN, TEST_MAIL_DOMAIN } from "./helpers/env";

/**
 * MAIL_DOMAIN and DOMAIN are one value in every other test, because that is what
 * a single-domain deployment looks like. Here they are deliberately split -- the
 * Worker served from drop.test, the boxes addressed at mail.test -- so anything
 * that builds an address out of the HTTP host, or a URL out of the mail domain,
 * shows up as a failure instead of a coincidence.
 */
function splitEnv(overrides: Partial<Env> = {}) {
	return makeEnv({ MAIL_DOMAIN: TEST_MAIL_DOMAIN, ...overrides });
}

describe("MAIL_DOMAIN addresses, DOMAIN URLs", () => {
	test("the fixtures really do differ", () => {
		expect(TEST_MAIL_DOMAIN).not.toBe(TEST_DOMAIN);
	});

	test("the From on a sent mail is the box at MAIL_DOMAIN", async () => {
		const email = makeEmail();
		const env = splitEnv({ EMAIL: email as unknown as Env["EMAIL"] });

		const res = await handleSend(
			jsonRequest(`https://${TEST_DOMAIN}/api/send/lisa`, {
				to: "bob@example.com",
				subject: "Plain",
				text: "hello",
			}),
			env,
			"lisa",
		);

		expect(res.status).toBe(200);
		expect(onlyBuilder(email).from).toBe(`lisa@${TEST_MAIL_DOMAIN}`);
	});

	test("a forward's From is the box at MAIL_DOMAIN", async () => {
		const email = makeEmail();
		const env = splitEnv({ EMAIL: email as unknown as Env["EMAIL"] });

		await forwardViaBinding(env, {
			box: "lisa",
			to: "bob@example.com",
			from: "sender@example.com",
			fromName: "Sender Person",
			subject: "look at this",
			textBody: "hello",
		});

		expect(onlyBuilder(email).from).toEqual({
			name: `Sender Person (via lisa@${TEST_MAIL_DOMAIN})`,
			email: `lisa@${TEST_MAIL_DOMAIN}`,
		});
	});

	test("webhook and hosting URLs stay on DOMAIN", () => {
		const env = splitEnv();
		expect(hookUrl(env, "lisa", "stripe-prod")).toBe(`https://${TEST_DOMAIN}/h/lisa/stripe-prod`);
		expect(siteUrl(env, "lisa", "marketing")).toBe(`https://${TEST_DOMAIN}/f/lisa/marketing/`);
	});
});
