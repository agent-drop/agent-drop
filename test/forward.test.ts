import { describe, expect, test } from "bun:test";
import { forwardViaBinding } from "../src/lib/relay";
import type { Env } from "../src/types";
import { makeEmail } from "./helpers/email";
import { makeEnv } from "./helpers/env";

function envWith(email: ReturnType<typeof makeEmail>) {
	return makeEnv({ EMAIL: email as unknown as Env["EMAIL"] });
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;

describe("forwardViaBinding -- inline attachments", () => {
	// postal-mime hands back the RAW Content-ID header value, angle brackets
	// included (`<logo123>`). Wrapping it again produces `<<logo123>>`, which no
	// client will match against `cid:logo123` -- the image silently fails to
	// render in every forwarded mail.
	test("does not double-wrap a Content-ID that already carries angle brackets", async () => {
		const email = makeEmail();
		await forwardViaBinding(envWith(email), {
			box: "lisa",
			to: "bob@example.com",
			from: "sender@example.com",
			subject: "look at this",
			htmlBody: '<img src="cid:logo123">',
			attachments: [
				{
					filename: "logo.png",
					mimeType: "image/png",
					content: PNG,
					contentId: "<logo123>",
					disposition: "inline",
				},
			],
		});

		const sent = email.raws();
		expect(sent).toHaveLength(1);
		expect(sent[0].raw).toContain("Content-ID: <logo123>");
		expect(sent[0].raw).not.toContain("<<logo123>>");
	});

	// The forward From is `"sender@example.com (via lisa@drop.test)" <lisa@drop.test>`.
	// Matching the first @ in that string yields the ORIGINAL sender's domain, so
	// every forwarded message announced a Message-ID from a domain we do not sign.
	test("derives the Message-ID domain from the envelope address, not the display name", async () => {
		const email = makeEmail();
		await forwardViaBinding(envWith(email), {
			box: "lisa",
			to: "bob@example.com",
			from: "sender@example.com",
			subject: "look at this",
			textBody: "hello",
		});

		const messageId = email.raws()[0].raw.match(/^Message-ID: (.+)$/m)?.[1];
		expect(messageId).toMatch(/@drop\.test>$/);
	});

	test("still brackets a bare Content-ID", async () => {
		const email = makeEmail();
		await forwardViaBinding(envWith(email), {
			box: "lisa",
			to: "bob@example.com",
			from: "sender@example.com",
			subject: "look at this",
			htmlBody: '<img src="cid:logo123">',
			attachments: [
				{
					filename: "logo.png",
					mimeType: "image/png",
					content: PNG,
					contentId: "logo123",
					disposition: "inline",
				},
			],
		});

		expect(email.raws()[0].raw).toContain("Content-ID: <logo123>");
	});
});
