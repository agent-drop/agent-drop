import { beforeEach, describe, expect, test } from "bun:test";
import PostalMime from "postal-mime";
import { handleEmail } from "../src/email-handler";
import { buildLegacyRelayAddress, pickSenderAddress } from "../src/lib/relay";
import type { Env, RelayQueueMessage } from "../src/types";
import { makeBucket, makeCtx, makeEnv, type TestEnv } from "./helpers/env";

interface IncomingEmail {
	message: ForwardableEmailMessage;
	rejection(): string | null;
}

/**
 * `from` is the envelope sender; `fromHeader` is the From header the sender's
 * client wrote, which is where a display name lives. They differ in real mail.
 * A `null` fromHeader omits the header; `extraHeaders` are written verbatim.
 */
function incoming(
	from: string,
	to: string,
	subject = "Hello",
	fromHeader: string | null = from,
	extraHeaders: string[] = [],
): IncomingEmail {
	const raw = [
		...(fromHeader === null ? [] : [`From: ${fromHeader}`]),
		...extraHeaders,
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

/** An env with one active mask `j-7k9m` relaying to owner@example.org. */
async function relayFixture(): Promise<{ env: TestEnv; queued: RelayQueueMessage[] }> {
	const queued: RelayQueueMessage[] = [];
	const env = makeEnv({
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
	return { env, queued };
}

const ROUTE = /^reply\+[0-9a-hjkmnp-tv-z]{26}@drop\.test$/;

/** The header section of a raw message, up to the blank line. */
function headerBlock(raw: string): string {
	return raw.slice(0, raw.indexOf("\r\n\r\n"));
}

/** One header's value, folded continuation lines included, exactly as written. */
function rawHeader(raw: string, name: string): string | undefined {
	return headerBlock(raw).match(new RegExp(`^${name}: (.*(?:\\r\\n[ \\t].*)*)`, "mi"))?.[1];
}

describe("authenticated relay reply routing", () => {
	let env: TestEnv;
	let queued: RelayQueueMessage[];

	beforeEach(async () => {
		({ env, queued } = await relayFixture());
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

// The opaque reply route hides the sender's address from the From line, so the
// display name is the only place the mask owner can still see who wrote. It
// follows the forward convention: "<sender> (via <mask address>)".
describe("inbound relay names the original sender", () => {
	let env: TestEnv;
	let queued: RelayQueueMessage[];

	beforeEach(async () => {
		({ env, queued } = await relayFixture());
	});

	async function relayFrom(envelopeFrom: string, fromHeader: string): Promise<RelayQueueMessage> {
		const inbound = incoming(envelopeFrom, "j-7k9m@drop.test", "Hello", fromHeader);
		await handleEmail(inbound.message, env, makeCtx());
		expect(inbound.rejection()).toBeNull();
		expect(queued).toHaveLength(1);
		return queued[0];
	}

	test("a named sender shows by name, via the mask, on the opaque route", async () => {
		const relayed = await relayFrom("lisa@example.com", '"Lisa Smith" <lisa@example.com>');

		expect(relayed.from).toMatch(ROUTE);
		expect(rawHeader(relayed.rawEmail, "From")).toBe(
			`"Lisa Smith (via j-7k9m@drop.test)" <${relayed.from}>`,
		);
		expect(rawHeader(relayed.rawEmail, "Reply-To")).toBe(relayed.from);
	});

	test("a sender with no display name shows by address", async () => {
		const relayed = await relayFrom("bob@example.com", "bob@example.com");

		expect(relayed.from).toMatch(ROUTE);
		expect(rawHeader(relayed.rawEmail, "From")).toBe(
			`"bob@example.com (via j-7k9m@drop.test)" <${relayed.from}>`,
		);
		expect(rawHeader(relayed.rawEmail, "Reply-To")).toBe(relayed.from);
	});

	// postal-mime decodes an RFC 2047 name verbatim, so a CRLF inside the encoded
	// word arrives in `parsed.from.name` as a real line break. Written into the
	// header unfiltered, it would start a Bcc: line of the attacker's choosing.
	test("a hostile display name cannot add a header, escape its quotes or move the address", async () => {
		const hostile = 'Evil "Boss" <ceo@corp.example>\r\nBcc: victim@example.net\\ Ärende Ö';
		const encoded = `=?UTF-8?B?${Buffer.from(hostile).toString("base64")}?=`;
		const relayed = await relayFrom("evil@example.net", `${encoded} <evil@example.net>`);
		const block = headerBlock(relayed.rawEmail);

		expect(block).not.toMatch(/^bcc:/im);
		// Every line is a header or a fold continuation, and no CR or LF stands alone.
		for (const line of block.split("\r\n")) expect(line).toMatch(/^([A-Za-z-]+: |[ \t])/);
		expect(block.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
		// Non-ASCII is RFC 2047-encoded, never raw bytes, and never inside quotes.
		expect(block).toMatch(/^[\x20-\x7e\r\n\t]*$/);
		const from = rawHeader(relayed.rawEmail, "From") ?? "";
		expect(from).toStartWith("=?UTF-8?B?");
		expect(from).toEndWith(` <${relayed.from}>`);

		const parsed = await new PostalMime().parse(relayed.rawEmail);
		expect(parsed.from).toEqual({
			address: relayed.from,
			name: "Evil Boss ceo@corp.example Bcc: victim@example.net Ärende Ö (via j-7k9m@drop.test)",
		});
		expect(parsed.bcc).toBeUndefined();
		expect(parsed.replyTo).toEqual([{ address: relayed.from, name: "" }]);
	});

	test("the reply route minted under a display name still routes the reply home", async () => {
		const relayed = await relayFrom("lisa@example.com", '"Lisa Smith" <lisa@example.com>');

		const reply = incoming("owner@example.org", relayed.from, "Re: Hello");
		await handleEmail(reply.message, env, makeCtx());

		expect(reply.rejection()).toBeNull();
		expect(queued[1]).toMatchObject({ direction: "reply", to: "lisa@example.com" });
	});
});

// The SMTP envelope sender of most bulk and transactional mail (SES, Mailchimp,
// Google Groups, Cloudflare Email Sending) is a bounce address, not a person. A
// reply through the mask must reach whoever a mail client would reply to.
describe("relay reply target follows the headers, not the envelope", () => {
	const BOUNCE = "bounce-123@cf-bounce.example";
	let env: TestEnv;
	let queued: RelayQueueMessage[];

	beforeEach(async () => {
		({ env, queued } = await relayFixture());
	});

	async function relay(fromHeader: string | null, extraHeaders: string[] = []) {
		const inbound = incoming(BOUNCE, "j-7k9m@drop.test", "Hello", fromHeader, extraHeaders);
		await handleEmail(inbound.message, env, makeCtx());
		expect(inbound.rejection()).toBeNull();
		expect(queued).toHaveLength(1);
		const route = env.DB.raw.query("SELECT sender FROM relay_reply_routes").all() as {
			sender: string;
		}[];
		expect(route).toHaveLength(1);
		return { relayed: queued[0], sender: route[0].sender };
	}

	test("with no Reply-To, the route replies to the From header address", async () => {
		const { relayed, sender } = await relay('"Pat" <pat@example.com>');

		expect(sender).toBe("pat@example.com");
		const reply = incoming("owner@example.org", relayed.from, "Re: Hello");
		await handleEmail(reply.message, env, makeCtx());
		expect(queued[1]).toMatchObject({ direction: "reply", to: "pat@example.com" });
	});

	test("a Reply-To header wins over From, as it would in a mail client", async () => {
		const { relayed, sender } = await relay('"Pat" <pat@example.com>', [
			"Reply-To: pat.replies@example.com",
		]);

		expect(sender).toBe("pat.replies@example.com");
		// The label still names the author, not where the reply goes.
		expect(rawHeader(relayed.rawEmail, "From")).toBe(
			`"Pat (via j-7k9m@drop.test)" <${relayed.from}>`,
		);
	});

	test("an unnamed sender is labelled with the From header address, never the envelope", async () => {
		const { relayed } = await relay("pat@example.com", ["Reply-To: help@example.com"]);

		expect(rawHeader(relayed.rawEmail, "From")).toBe(
			`"pat@example.com (via j-7k9m@drop.test)" <${relayed.from}>`,
		);
	});

	test("the first valid Reply-To address is used when several are listed", async () => {
		const { sender } = await relay("pat@example.com", [
			"Reply-To: garbage, first@example.net, second@example.org",
		]);
		expect(sender).toBe("first@example.net");
	});

	test("a Reply-To group is read member by member", async () => {
		const { sender } = await relay("pat@example.com", [
			"Reply-To: team: lead@example.net, other@example.net;",
		]);
		expect(sender).toBe("lead@example.net");
	});

	test.each([
		["no @", "Reply-To: not-an-address", "pat@example.com"],
		["whitespace", "Reply-To: <pat @example.com>", "pat@example.com"],
		["two @", "Reply-To: <a@b@example.com>", "pat@example.com"],
		["empty", "Reply-To:", "pat@example.com"],
		["empty angle", "Reply-To: <>", "pat@example.com"],
	])("a malformed Reply-To (%s) falls back to the From header", async (_, header, expected) => {
		const { sender } = await relay('"Pat" <pat@example.com>', [header]);
		expect(sender).toBe(expected);
	});

	test.each([
		["missing", null],
		["empty", ""],
		["empty angle", "<>"],
		["no @", "not-an-address"],
		["two @", "<a@b@example.com>"],
		[
			"encoded word as address",
			`<=?UTF-8?B?${Buffer.from("a\r\nb@evil.example").toString("base64")}?=>`,
		],
	])("a malformed From (%s) with no Reply-To falls back to the envelope", async (_, header) => {
		const { sender } = await relay(header);
		expect(sender).toBe(BOUNCE);
	});

	test("with no usable header address and no name, the label falls back to the envelope", async () => {
		const { relayed } = await relay("<>");
		expect(rawHeader(relayed.rawEmail, "From")).toBe(
			`"${BOUNCE} (via j-7k9m@drop.test)" <${relayed.from}>`,
		);
	});
});

// postal-mime already drops most control characters from a parsed address, so
// the strict check is pinned here directly rather than through a raw message.
describe("pickSenderAddress", () => {
	const ENVELOPE = "bounce@cf-bounce.example";
	const mailbox = (address: string) => ({ address, name: "" });

	test.each([
		["CRLF", "pat@example.com\r\nBcc: victim@example.net"],
		["NUL", "pat\u0000@example.com"],
		["DEL", "pat@example.com\u007f"],
		["tab", "pat\t@example.com"],
		["angle brackets", "<pat@example.com>"],
		["display-name form", "Pat <pat@example.com>"],
		["comma list", "a@example.com,b@example.com"],
		["no local part", "@example.com"],
		["no domain", "pat@"],
		["empty", ""],
	])("rejects %s and moves to the next source", (_, bad) => {
		expect(pickSenderAddress([mailbox(bad), mailbox("next@example.com")], ENVELOPE)).toBe(
			"next@example.com",
		);
		expect(pickSenderAddress([[mailbox(bad)]], ENVELOPE)).toBe(ENVELOPE);
	});

	test("reads sources in order and returns the envelope when none has a valid address", () => {
		expect(
			pickSenderAddress([[mailbox("reply@example.com")], mailbox("from@example.com")], ENVELOPE),
		).toBe("reply@example.com");
		expect(pickSenderAddress([undefined, mailbox("from@example.com")], ENVELOPE)).toBe(
			"from@example.com",
		);
		expect(pickSenderAddress([undefined, undefined], ENVELOPE)).toBe(ENVELOPE);
		expect(pickSenderAddress([[], { name: "Team", group: [] }], ENVELOPE)).toBe(ENVELOPE);
	});
});
