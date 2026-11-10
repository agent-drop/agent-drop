import { describe, expect, test } from "bun:test";
import {
	handleCompose,
	handleSend,
	MAX_ATTACHMENTS,
	MAX_ATTACHMENT_TOTAL_BYTES,
	MAX_EMAIL_REQUEST_BYTES,
	MAX_INLINE_ATTACHMENT_BYTES,
} from "../src/api/send";
import type { Env } from "../src/types";
import { type FakeEmail, makeEmail, onlyBuilder } from "./helpers/email";
import { jsonRequest, makeBucket, makeEnv, type TestEnv } from "./helpers/env";

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

/**
 * Every body part in the preview is base64 with a Content-Transfer-Encoding
 * header to say so, exactly as a mail client expects. Decode them all and
 * concatenate, so a test can assert on what a reader would see.
 */
function decodeParts(eml: string): string {
	return eml
		.split(/^--+=_Part_[^\r\n]*\r?\n?/m)
		.slice(1)
		.map((part) => {
			const [, body = ""] = part.split(/\r\n\r\n/);
			try {
				return atob(body.replace(/\s+/g, ""));
			} catch {
				return body;
			}
		})
		.join("\n");
}

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

	test("a drop id from another inbox cannot supply threading headers", async () => {
		const email = makeEmail();
		const env = makeEnv({ EMAIL: email as unknown as Env["EMAIL"] });
		await env.DB.prepare(
			"INSERT INTO drops (id, inbox, channel, metadata, created_at) VALUES (?, ?, 'email', ?, ?)",
		)
			.bind(
				"01knbobthread",
				"bob",
				JSON.stringify({ message_id: "<bob-secret@mail.example.com>" }),
				Date.now(),
			)
			.run();

		const response = await handleSend(
			jsonRequest("https://drop.test/api/send/lisa", {
				...PLAIN,
				inReplyTo: "01knbobthread",
			}),
			env,
			"lisa",
		);

		expect(response.status).toBe(200);
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

describe("handleSend -- outbound R2 attachment ownership", () => {
	test("reads an attachment uploaded under the sending inbox", async () => {
		const email = makeEmail();
		const key = "outbound/temp/lisa/upload/report.txt";
		const env = makeEnv({
			BUCKET: makeBucket({ [key]: "owned attachment" }),
			EMAIL: email as unknown as Env["EMAIL"],
		});

		const response = await handleSend(
			jsonRequest("https://drop.test/api/send/lisa", {
				...PLAIN,
				attachments: [{ r2Key: key }],
			}),
			env,
			"lisa",
		);

		expect(response.status).toBe(200);
		expect(
			new TextDecoder().decode(onlyBuilder(email).attachments?.[0].content as ArrayBuffer),
		).toBe("owned attachment");
	});

	test("rejects an R2 key outside the sending inbox before reading it", async () => {
		const email = makeEmail();
		const env = makeEnv({
			BUCKET: makeBucket({ "sites/bob/private/index.html": "secret" }),
			EMAIL: email as unknown as Env["EMAIL"],
		});

		const response = await handleSend(
			jsonRequest("https://drop.test/api/send/lisa", {
				...PLAIN,
				attachments: [{ r2Key: "sites/bob/private/index.html" }],
			}),
			env,
			"lisa",
		);

		expect(response.status).toBe(400);
		expect((await response.json()) as { error: string }).toEqual({
			error: "R2 attachment key is not owned by this inbox",
		});
		expect(email.sends).toHaveLength(0);
	});

	test("deleteAfterSend cannot delete another inbox's temporary object", async () => {
		const bucket = makeBucket({ "outbound/temp/bob/upload/report.txt": "keep me" });
		const env = makeEnv({ BUCKET: bucket, EMAIL: makeEmail() as unknown as Env["EMAIL"] });
		const response = await handleSend(
			jsonRequest("https://drop.test/api/send/lisa", {
				...PLAIN,
				deleteAfterSend: true,
				attachments: [
					{
						dataBase64: "b3duZWQgYnl0ZXM=",
						r2Key: "outbound/temp/bob/upload/report.txt",
					},
				],
			}),
			env,
			"lisa",
		);

		expect(response.status).toBe(200);
		expect(bucket.deletes).toEqual([]);
	});
});

describe("handleSend -- markdown becomes both parts", () => {
	const REPORT = "# Retrospect\n\n| leg | cost |\n|---|--:|\n| one | 3 |\n\n```sh\nbun test\n```";

	test("markdown alone fills html AND text -- the raw markdown is the text part", async () => {
		const { email } = await send({ to: "bob@example.com", subject: "Retro", markdown: REPORT });

		const builder = onlyBuilder(email);
		// The text part is the source, verbatim: markdown is the one markup a
		// plain-text reader can still read.
		expect(builder.text).toBe(REPORT);
		expect(builder.html).toContain("<h1 style=");
		expect(builder.html).toContain("<table");
		expect(builder.html).toContain("<pre style=");
	});

	test("an explicit text wins the text part while markdown still renders the html", async () => {
		const { email } = await send({
			to: "bob@example.com",
			subject: "Retro",
			markdown: "# hi",
			text: "plain summary",
		});

		const builder = onlyBuilder(email);
		expect(builder.text).toBe("plain summary");
		expect(builder.html).toContain("<h1 style=");
	});

	test("the subject reaches the rendered document's title", async () => {
		const { email } = await send({ to: "bob@example.com", subject: "Retro", markdown: "# hi" });

		expect(onlyBuilder(email).html).toContain("<title>Retro</title>");
	});

	test("markdown alone satisfies the body requirement", async () => {
		const { response } = await send({ to: "bob@example.com", subject: "s", markdown: "hi" });

		expect(response.status).toBe(200);
	});

	// The log used to read `body.text || body.html`, neither of which a markdown
	// send has -- so the row would have recorded an empty body.
	test("the outbound log records the rendered text part, not an empty string", async () => {
		const email = makeEmail();
		const env = makeEnv({ EMAIL: email as unknown as Env["EMAIL"] });
		await handleSend(
			jsonRequest("https://drop.test/api/send/lisa", {
				to: "bob@example.com",
				subject: "Retro",
				markdown: "# Retrospect",
			}),
			env,
			"lisa",
		);

		const row = env.DB.raw.query("SELECT body_text FROM outbound").get() as { body_text: string };
		expect(row.body_text).toBe("# Retrospect");
	});

	test("a markdown attachment-only send still works alongside attachments", async () => {
		const { email, response } = await send({
			to: "bob@example.com",
			subject: "Retro",
			markdown: "See ![logo](cid:logo)",
			attachments: [
				{ filename: "logo.png", contentType: "image/png", dataBase64: "aGVsbG8=", cid: "logo" },
			],
		});

		expect(response.status).toBe(200);
		const builder = onlyBuilder(email);
		// `cid:` survives the URL filter precisely so this works from markdown.
		expect(builder.html).toContain('src="cid:logo"');
		expect((builder.attachments ?? [])[0].contentId).toBe("logo");
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

describe("handleSend -- attachment resource budgets", () => {
	test("accepts exactly the documented attachment-count limit", async () => {
		const attachments = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => ({
			filename: `${i}.txt`,
			dataBase64: "eA==",
		}));
		const { email, response } = await send({ ...PLAIN, attachments });

		expect(response.status).toBe(200);
		expect(onlyBuilder(email).attachments).toHaveLength(MAX_ATTACHMENTS);
	});

	test("rejects an attachment count over the limit before resolving any source", async () => {
		const attachments = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({
			url: `https://example.com/${i}.txt`,
		}));
		const { email, response } = await send({ ...PLAIN, attachments });

		expect(response.status).toBe(413);
		expect((await response.json()) as { error: string }).toEqual({
			error: `too many attachments (max ${MAX_ATTACHMENTS})`,
		});
		expect(email.sends).toHaveLength(0);
	});

	test("rejects inline base64 that decodes above its per-file limit", async () => {
		const dataBase64 = Buffer.alloc(MAX_INLINE_ATTACHMENT_BYTES + 1).toString("base64");
		const { email, response } = await send({
			...PLAIN,
			attachments: [{ filename: "large.bin", dataBase64 }],
		});

		expect(response.status).toBe(413);
		expect(email.sends).toHaveLength(0);
	});

	test("uses R2 metadata to reject an over-budget attachment before reading its body", async () => {
		let bodyRead = false;
		const key = "outbound/temp/lisa/upload/large.bin";
		const bucket = {
			get: async () => ({
				key,
				size: MAX_ATTACHMENT_TOTAL_BYTES + 1,
				arrayBuffer: async () => {
					bodyRead = true;
					return new ArrayBuffer(0);
				},
			}),
		} as unknown as R2Bucket;
		const email = makeEmail();
		const env = makeEnv({ BUCKET: bucket, EMAIL: email as unknown as Env["EMAIL"] });

		const response = await handleSend(
			jsonRequest("https://drop.test/api/send/lisa", {
				...PLAIN,
				attachments: [{ r2Key: key }],
			}),
			env,
			"lisa",
		);

		expect(response.status).toBe(413);
		expect(bodyRead).toBe(false);
		expect(email.sends).toHaveLength(0);
	});

	test("resolves sequentially and stops before reading an attachment that exceeds the remainder", async () => {
		const first = "outbound/temp/lisa/upload/first.bin";
		const second = "outbound/temp/lisa/upload/second.bin";
		const nineMiB = 9 * 1024 * 1024;
		const bodyReads: string[] = [];
		const bucket = {
			get: async (key: string) => ({
				key,
				size: nineMiB,
				arrayBuffer: async () => {
					bodyReads.push(key);
					return new ArrayBuffer(nineMiB);
				},
			}),
		} as unknown as R2Bucket;
		const email = makeEmail();
		const env = makeEnv({ BUCKET: bucket, EMAIL: email as unknown as Env["EMAIL"] });

		const response = await handleSend(
			jsonRequest("https://drop.test/api/send/lisa", {
				...PLAIN,
				attachments: [{ r2Key: first }, { r2Key: second }],
			}),
			env,
			"lisa",
		);

		expect(response.status).toBe(413);
		expect(bodyReads).toEqual([first]);
		expect(email.sends).toHaveLength(0);
	});

	test("keeps HTTP(S) URL attachments while rejecting oversized declared responses", async () => {
		const realFetch = globalThis.fetch;
		let cancelled = false;
		globalThis.fetch = (async () => {
			const stream = new ReadableStream<Uint8Array>({
				cancel() {
					cancelled = true;
				},
			});
			return new Response(stream, {
				headers: { "Content-Length": String(MAX_ATTACHMENT_TOTAL_BYTES + 1) },
			});
		}) as unknown as typeof fetch;

		try {
			const { email, response } = await send({
				...PLAIN,
				attachments: [{ url: "https://example.com/large.bin" }],
			});
			expect(response.status).toBe(413);
			expect(cancelled).toBe(true);
			expect(email.sends).toHaveLength(0);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test("still fetches a normal remote URL attachment byte-for-byte", async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response("remote report", {
				headers: { "Content-Type": "text/plain", "Content-Length": "13" },
			})) as unknown as typeof fetch;

		try {
			const { email, response } = await send({
				...PLAIN,
				attachments: [{ url: "https://example.com/report.txt" }],
			});
			expect(response.status).toBe(200);
			const content = onlyBuilder(email).attachments?.[0].content as ArrayBufferView;
			expect(new TextDecoder().decode(content)).toBe("remote report");
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test("rejects non-HTTP attachment URLs without fetching them", async () => {
		const realFetch = globalThis.fetch;
		let fetched = false;
		globalThis.fetch = (async () => {
			fetched = true;
			return new Response("unexpected");
		}) as unknown as typeof fetch;

		try {
			const { email, response } = await send({
				...PLAIN,
				attachments: [{ url: "data:text/plain,hello" }],
			});
			expect(response.status).toBe(400);
			expect(fetched).toBe(false);
			expect(email.sends).toHaveLength(0);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test("rejects an oversized JSON request from Content-Length before parsing it", async () => {
		const email = makeEmail();
		const env = makeEnv({ EMAIL: email as unknown as Env["EMAIL"] });
		const response = await handleSend(
			new Request("https://drop.test/api/send/lisa", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": String(MAX_EMAIL_REQUEST_BYTES + 1),
				},
				body: JSON.stringify(PLAIN),
			}),
			env,
			"lisa",
		);

		expect(response.status).toBe(413);
		expect(email.sends).toHaveLength(0);
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
			/text, html, markdown, or attachments/,
		);
	});

	// Two sources for one MIME part. Picking a winner silently is how a caller
	// ends up wondering which half of its message went missing.
	test("markdown and html together is a 400, not a silent preference", async () => {
		const { email, response } = await send({
			...PLAIN,
			markdown: "# hi",
			html: "<p>hi</p>",
		});

		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toMatch(/not both/);
		expect(email.sends).toHaveLength(0);
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

	// The whole value of `--dry-run` on a markdown send is seeing the RENDERED
	// html, not the markdown source echoed back. Compose shares prepareEmail with
	// send, so the two cannot disagree about what was rendered.
	test("a markdown send previews as a real multipart with the rendered html", async () => {
		const eml = await compose({
			to: "bob@example.com",
			subject: "Retro",
			markdown: "# Retrospect\n\n| a | b |\n|---|---|\n| 1 | 2 |",
		});

		expect(eml).toContain("multipart/alternative");
		expect(eml).toContain("text/plain");
		expect(eml).toContain("text/html");

		// The parts are base64 in the .eml, so the assertion has to go through the
		// same decode a mail client does.
		const decoded = decodeParts(eml);
		expect(decoded).toContain("# Retrospect");
		expect(decoded).toContain("<h1 style=");
		expect(decoded).toContain("<table");
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
