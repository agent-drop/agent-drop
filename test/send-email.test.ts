import { describe, expect, test } from "bun:test";
import { handleCompose, handleSend } from "../src/api/send";
import type { Env } from "../src/types";
import { type FakeEmail, makeEmail, onlyBuilder } from "./helpers/email";
import { jsonRequest, makeEnv, type TestEnv } from "./helpers/env";

/**
 * The representative message set the PLAN names for phase 3, asserted against
 * the payload that actually reaches the binding.
 *
 * The CLI's `send-email --dry-run` renders these through /api/compose; that
 * output was diffed old-vs-new by hand at migration time. What is pinned here is
 * the other half: that the builder handed to env.EMAIL.send() carries the same
 * fields the preview shows, so the two cannot drift apart later.
 */

interface SendResult {
	env: TestEnv;
	email: FakeEmail;
	response: Response;
}

async function send(body: unknown, inbox = "lisa"): Promise<SendResult> {
	const email = makeEmail();
	const env = makeEnv({ EMAIL: email as unknown as Env["EMAIL"] });
	const response = await handleSend(
		jsonRequest(`https://drop.test/api/send/${inbox}`, body),
		env,
		inbox,
	);
	return { env, email, response };
}

async function compose(body: unknown, inbox = "lisa"): Promise<string> {
	const email = makeEmail();
	const env = makeEnv({ EMAIL: email as unknown as Env["EMAIL"] });
	const response = await handleCompose(
		jsonRequest(`https://drop.test/api/compose/${inbox}`, body),
		env,
		inbox,
	);
	expect(response.status).toBe(200);
	// Nothing may leave the building on the compose path.
	expect(email.sends).toHaveLength(0);
	return response.text();
}

const PLAIN = { to: "bob@example.com", subject: "Plain", text: "hello" };

describe("handleSend -- one send for the whole recipient list", () => {
	test("plain text", async () => {
		const { email, response } = await send(PLAIN);

		expect(response.status).toBe(200);
		const builder = onlyBuilder(email);
		expect(builder.from).toBe("lisa@drop.test");
		expect(builder.to).toEqual(["bob@example.com"]);
		expect(builder.subject).toBe("Plain");
		expect(builder.text).toBe("hello");
		expect(builder.html).toBeUndefined();
		expect(builder.attachments).toBeUndefined();
	});

	test("text and html", async () => {
		const { email } = await send({ ...PLAIN, html: "<p>rich</p>" });

		const builder = onlyBuilder(email);
		expect(builder.text).toBe("hello");
		expect(builder.html).toBe("<p>rich</p>");
	});

	// The old path sent one raw message per envelope recipient. The whole point of
	// the builder is that this is a single send carrying the full list.
	test("multiple to/cc/bcc go out in ONE send, not one per recipient", async () => {
		const { email } = await send({
			to: ["bob@example.com", "carol@example.com"],
			cc: ["team@example.com", "ops@example.com"],
			bcc: ["audit@example.com"],
			subject: "Everyone",
			text: "broadcast",
		});

		expect(email.sends).toHaveLength(1);
		const builder = onlyBuilder(email);
		expect(builder.to).toEqual(["bob@example.com", "carol@example.com"]);
		expect(builder.cc).toEqual(["team@example.com", "ops@example.com"]);
		expect(builder.bcc).toEqual(["audit@example.com"]);
	});

	test("a cc-only send carries no empty to list", async () => {
		const { email } = await send({ cc: "team@example.com", subject: "Cc", text: "hi" });

		const builder = onlyBuilder(email);
		expect(builder.to).toBeUndefined();
		expect(builder.cc).toEqual(["team@example.com"]);
	});

	test("display-name recipients become address objects, bare ones stay strings", async () => {
		const { email } = await send({
			to: ['"Bob Loblaw" <bob@example.com>', "alice@example.com"],
			subject: "Named",
			text: "hi",
		});

		expect(onlyBuilder(email).to).toEqual([
			{ name: "Bob Loblaw", email: "bob@example.com" },
			"alice@example.com",
		]);
	});

	test("fromName and replyTo", async () => {
		const { email } = await send({ ...PLAIN, fromName: "Lisa", replyTo: "lisa@drop.test" });

		const builder = onlyBuilder(email);
		expect(builder.from).toEqual({ name: "Lisa", email: "lisa@drop.test" });
		expect(builder.replyTo).toBe("lisa@drop.test");
	});

	test("+addressing puts the topic in the From local part", async () => {
		const { email } = await send({ ...PLAIN, topic: "sales" });

		expect(onlyBuilder(email).from).toBe("lisa+sales@drop.test");
	});

	test("a raw message-id threads via In-Reply-To and References", async () => {
		const { email } = await send({ ...PLAIN, inReplyTo: "<orig@mail.example.com>" });

		expect(onlyBuilder(email).headers).toEqual({
			"In-Reply-To": "<orig@mail.example.com>",
			References: "<orig@mail.example.com>",
		});
	});

	test("a drop id threads via that drop's stored message-id", async () => {
		const email = makeEmail();
		const env = makeEnv({ EMAIL: email as unknown as Env["EMAIL"] });
		await env.DB.prepare(
			"INSERT INTO drops (id, inbox, channel, metadata, created_at) VALUES (?, ?, 'email', ?, ?)",
		)
			.bind(
				"01knthread",
				"lisa",
				JSON.stringify({ message_id: "<stored@mail.example.com>" }),
				Date.now(),
			)
			.run();

		await handleSend(
			jsonRequest("https://drop.test/api/send/lisa", { ...PLAIN, inReplyTo: "01knthread" }),
			env,
			"lisa",
		);

		expect(onlyBuilder(email).headers).toEqual({
			"In-Reply-To": "<stored@mail.example.com>",
			References: "<stored@mail.example.com>",
		});
	});

	test("an unknown drop id threads nothing rather than inventing a header", async () => {
		const { email } = await send({ ...PLAIN, inReplyTo: "01knnosuchdrop" });

		expect(onlyBuilder(email).headers).toBeUndefined();
	});

	test("logs the outbound row with the platform message id", async () => {
		const email = makeEmail({ messageId: "cf-xyz-9" });
		const env = makeEnv({ EMAIL: email as unknown as Env["EMAIL"] });
		await handleSend(
			jsonRequest("https://drop.test/api/send/lisa", { ...PLAIN, cc: "team@example.com" }),
			env,
			"lisa",
		);

		const row = env.DB.raw.query("SELECT to_addr, ses_message_id FROM outbound").get() as {
			to_addr: string;
			ses_message_id: string;
		};
		expect(row.ses_message_id).toBe("cf-xyz-9");
		expect(row.to_addr).toBe("bob@example.com, team@example.com");
	});
});

describe("handleSend -- attachments reach the binding as bytes", () => {
	// "hello" as base64. The binding reads a string `content` as RAW content, so
	// forwarding the base64 string would attach the literal text "aGVsbG8=".
	const HELLO_B64 = "aGVsbG8=";

	test("a base64 attachment is decoded before it is handed over", async () => {
		const { email } = await send({
			...PLAIN,
			attachments: [{ filename: "note.txt", contentType: "text/plain", dataBase64: HELLO_B64 }],
		});

		const [attachment] = onlyBuilder(email).attachments ?? [];
		expect(attachment.filename).toBe("note.txt");
		expect(attachment.type).toBe("text/plain");
		expect(attachment.disposition).toBe("attachment");
		expect(new TextDecoder().decode(attachment.content as ArrayBuffer)).toBe("hello");
	});

	test("an inline cid attachment keeps its content id", async () => {
		const { email } = await send({
			to: "bob@example.com",
			subject: "Inline",
			html: '<img src="cid:logo">',
			attachments: [
				{ filename: "logo.png", contentType: "image/png", dataBase64: HELLO_B64, cid: "logo" },
			],
		});

		const [attachment] = onlyBuilder(email).attachments ?? [];
		expect(attachment.disposition).toBe("inline");
		expect(attachment.contentId).toBe("logo");
	});
});

describe("prepareEmail -- validation", () => {
	async function errorOf(body: unknown): Promise<string> {
		const { response } = await send(body);
		expect(response.status).toBe(400);
		return ((await response.json()) as { error: string }).error;
	}

	test("no recipients", async () => {
		expect(await errorOf({ subject: "s", text: "t" })).toMatch(/at least one recipient/);
	});

	test("no subject", async () => {
		expect(await errorOf({ to: "bob@example.com", text: "t" })).toMatch(/subject is required/);
	});

	test("no body and no attachments", async () => {
		expect(await errorOf({ to: "bob@example.com", subject: "s" })).toMatch(
			/text, html, or attachments/,
		);
	});

	test("over 50 combined recipients is rejected before the send", async () => {
		const many = Array.from({ length: 51 }, (_, i) => `r${i}@example.com`);
		const { email, response } = await send({ to: many, subject: "s", text: "t" });

		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toMatch(/too many recipients: 51/);
		expect(email.sends).toHaveLength(0);
	});

	test("an unresolvable attachment fails the request instead of sending a broken mail", async () => {
		const { email, response } = await send({
			...PLAIN,
			attachments: [{ filename: "x", contentType: "text/plain" }],
		});

		expect(response.status).toBe(400);
		expect(email.sends).toHaveLength(0);
	});
});

describe("handleCompose -- the dry-run preview", () => {
	test("returns rfc822 and sends nothing", async () => {
		const eml = await compose(PLAIN);

		expect(eml).toContain("From: lisa@drop.test");
		expect(eml).toContain("To: bob@example.com");
		expect(eml).toContain("Subject: Plain");
	});

	// The preview is rendered FROM the builder, so a field that survives into the
	// builder must show up here, and one that does not, must not.
	test("shows every field the builder carries", async () => {
		const eml = await compose({
			to: ['"Bob Loblaw" <bob@example.com>'],
			cc: "team@example.com",
			subject: "Named",
			text: "hi",
			html: "<p>hi</p>",
			fromName: "Lisa",
			replyTo: "lisa@drop.test",
			topic: "sales",
			inReplyTo: "<orig@mail.example.com>",
		});

		expect(eml).toContain('From: "Lisa" <lisa+sales@drop.test>');
		expect(eml).toContain('To: "Bob Loblaw" <bob@example.com>');
		expect(eml).toContain("Cc: team@example.com");
		expect(eml).toContain("Reply-To: lisa@drop.test");
		expect(eml).toContain("In-Reply-To: <orig@mail.example.com>");
		expect(eml).toContain("References: <orig@mail.example.com>");
		expect(eml).toContain("multipart/alternative");
	});

	// Bcc is deliberately absent from the rendered headers -- it is an envelope
	// concern the binding owns, and showing it would misrepresent the wire format.
	test("omits Bcc, matching what the sent message's headers carry", async () => {
		const eml = await compose({ ...PLAIN, bcc: "audit@example.com" });

		expect(eml).not.toContain("audit@example.com");
	});

	test("an inline attachment round-trips back to base64 losslessly", async () => {
		const eml = await compose({
			to: "bob@example.com",
			subject: "Inline",
			html: '<img src="cid:logo">',
			attachments: [
				{ filename: "logo.png", contentType: "image/png", dataBase64: "aGVsbG8=", cid: "logo" },
			],
		});

		expect(eml).toContain("Content-ID: <logo>");
		expect(eml).toContain('Content-Disposition: inline; filename="logo.png"');
		expect(eml).toContain("aGVsbG8=");
	});

	test("validation errors surface on the compose path too", async () => {
		const email = makeEmail();
		const env = makeEnv({ EMAIL: email as unknown as Env["EMAIL"] });
		const response = await handleCompose(
			jsonRequest("https://drop.test/api/compose/lisa", { subject: "s", text: "t" }),
			env,
			"lisa",
		);

		expect(response.status).toBe(400);
	});
});
