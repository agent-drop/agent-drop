import { describe, expect, test } from "bun:test";
import { forwardViaBinding } from "../src/lib/relay";
import type { Env } from "../src/types";
import { type FakeEmail, makeEmail, onlyBuilder } from "./helpers/email";
import { makeEnv } from "./helpers/env";

function envWith(email: FakeEmail) {
	return makeEnv({ EMAIL: email as unknown as Env["EMAIL"] });
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function forward(email: FakeEmail, overrides: Record<string, unknown> = {}) {
	return forwardViaBinding(envWith(email), {
		box: "lisa",
		to: "bob@example.com",
		from: "sender@example.com",
		subject: "look at this",
		textBody: "hello",
		...overrides,
	});
}

describe("forwardViaBinding -- envelope", () => {
	test("From is the box, the original sender is preserved in Reply-To", async () => {
		const email = makeEmail();
		await forward(email, { fromName: "Sender Person" });

		const builder = onlyBuilder(email);
		expect(builder.from).toEqual({
			name: "Sender Person (via lisa@drop.test)",
			email: "lisa@drop.test",
		});
		expect(builder.to).toBe("bob@example.com");
		expect(builder.replyTo).toBe("sender@example.com");
		expect(builder.subject).toBe("look at this");
		expect(builder.text).toBe("hello");
	});

	test("falls back to the sender address when there is no display name", async () => {
		const email = makeEmail();
		await forward(email, { fromName: null });

		expect(onlyBuilder(email).from).toEqual({
			name: "sender@example.com (via lisa@drop.test)",
			email: "lisa@drop.test",
		});
	});

	// Same label as the mask relay, built by the same helper. The name is the
	// sender's own From header, decoded: a CRLF in it is a real line break.
	test("a hostile display name is reduced to inert text before the binding sees it", async () => {
		const email = makeEmail();
		await forward(email, {
			fromName: 'Evil "Boss" <ceo@corp.example>\r\nBcc: victim@example.net\\ Ärende Ö',
		});

		expect(onlyBuilder(email).from).toEqual({
			name: "Evil Boss ceo@corp.example Bcc: victim@example.net Ärende Ö (via lisa@drop.test)",
			email: "lisa@drop.test",
		});
	});

	test("a subject-less forward still carries a subject", async () => {
		const email = makeEmail();
		await forward(email, { subject: null });

		expect(onlyBuilder(email).subject).toBe("(no subject)");
	});

	test("threads to the original via References, not In-Reply-To", async () => {
		const email = makeEmail();
		await forward(email, { messageId: "<orig@mail.example.com>" });

		const builder = onlyBuilder(email);
		expect(builder.headers).toEqual({ References: "<orig@mail.example.com>" });
	});

	test("returns the platform message id", async () => {
		const email = makeEmail({ messageId: "cf-abc-123" });
		expect(await forward(email)).toBe("cf-abc-123");
	});
});

// The PLAN left open whether forwardViaBinding could migrate at all, since it
// re-attaches the original message's attachments. It can: EmailAttachment takes
// `content` as ArrayBuffer/ArrayBufferView/string, which is exactly what
// postal-mime hands back, so nothing is re-encoded on the way out.
describe("forwardViaBinding -- attachment re-encoding", () => {
	test("binary attachment bytes ride through untouched", async () => {
		const email = makeEmail();
		await forward(email, {
			attachments: [
				{
					filename: "logo.png",
					mimeType: "image/png",
					content: PNG_BYTES,
					disposition: "attachment",
				},
			],
		});

		const [attachment] = onlyBuilder(email).attachments ?? [];
		expect(attachment).toBeDefined();
		expect(attachment.filename).toBe("logo.png");
		expect(attachment.type).toBe("image/png");
		expect(attachment.disposition).toBe("attachment");
		// Identity, not a base64 round-trip: the binding takes raw bytes.
		expect(attachment.content).toBe(PNG_BYTES);
	});

	test("a text attachment stays a string rather than becoming base64 text", async () => {
		const email = makeEmail();
		await forward(email, {
			attachments: [
				{
					filename: "notes.txt",
					mimeType: "text/plain",
					content: "line one\nline two",
					disposition: "attachment",
				},
			],
		});

		expect(onlyBuilder(email).attachments?.[0].content).toBe("line one\nline two");
	});

	test("missing filename and mime type get defaults the binding accepts", async () => {
		const email = makeEmail();
		await forward(email, { attachments: [{ content: PNG_BYTES }] });

		const [attachment] = onlyBuilder(email).attachments ?? [];
		expect(attachment.filename).toBe("attachment");
		expect(attachment.type).toBe("application/octet-stream");
	});
});

describe("forwardViaBinding -- inline attachments", () => {
	// postal-mime hands back the RAW Content-ID header value, angle brackets
	// included. Passing "<logo123>" straight through would put "<<logo123>>" on
	// the wire, which no client matches against `cid:logo123` -- the image
	// silently fails to render in every forwarded mail.
	test("normalises a bracketed Content-ID to the bare token", async () => {
		const email = makeEmail();
		await forward(email, {
			htmlBody: '<img src="cid:logo123">',
			attachments: [
				{
					filename: "logo.png",
					mimeType: "image/png",
					content: PNG_BYTES,
					contentId: "<logo123>",
					disposition: "inline",
				},
			],
		});

		const [attachment] = onlyBuilder(email).attachments ?? [];
		expect(attachment.disposition).toBe("inline");
		expect(attachment.contentId).toBe("logo123");
	});

	test("a bare Content-ID is left alone", async () => {
		const email = makeEmail();
		await forward(email, {
			attachments: [
				{ filename: "logo.png", mimeType: "image/png", content: PNG_BYTES, contentId: "logo123" },
			],
		});

		expect(onlyBuilder(email).attachments?.[0].contentId).toBe("logo123");
	});

	// A contentId is what makes an inline part addressable. Without one, "inline"
	// is not representable in the binding's attachment union, and an unaddressable
	// inline part is just an attachment.
	test("an inline part with no Content-ID degrades to a regular attachment", async () => {
		const email = makeEmail();
		await forward(email, {
			attachments: [
				{
					filename: "logo.png",
					mimeType: "image/png",
					content: PNG_BYTES,
					disposition: "inline",
				},
			],
		});

		const [attachment] = onlyBuilder(email).attachments ?? [];
		expect(attachment.disposition).toBe("attachment");
		expect(attachment.contentId).toBeUndefined();
	});

	test("a Content-ID alone marks the part inline, as postal-mime implies", async () => {
		const email = makeEmail();
		await forward(email, {
			attachments: [
				{ filename: "logo.png", mimeType: "image/png", content: PNG_BYTES, contentId: "<logo123>" },
			],
		});

		expect(onlyBuilder(email).attachments?.[0].disposition).toBe("inline");
	});
});
