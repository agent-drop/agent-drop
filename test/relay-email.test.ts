import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import PostalMime from "postal-mime";
import { handleEmail } from "../src/email-handler";
import { buildLegacyRelayAddress, pickSenderAddress } from "../src/lib/relay";
import type { Env, RelayQueueMessage } from "../src/types";
import { makeBucket, makeCtx, makeEnv, type TestEnv } from "./helpers/env";
import { type IncomingEmail, incoming } from "./helpers/inbound";

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

/** The relay rule's target in `relayFixture`: the only mailbox that may reply. */
const OWNER = "owner@example.org";

/**
 * The Authentication-Results field Cloudflare prepends, so it is the first one
 * physically in the message. Fields a sender wrote come after it.
 */
function cloudflareAuth(...clauses: string[]): string {
	return `Authentication-Results: mx.cloudflare.net; ${clauses.join("; ")}`;
}

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

// A reply route is an address, and addresses leak: the owner forwards or CCs the
// relayed mail, a list archives it, a mailbox is compromised. Whoever holds one
// must not be able to send as the mask, so only the relay rule's target may.
describe("only the mask owner may reply through a relay route", () => {
	let env: TestEnv;
	let queued: RelayQueueMessage[];
	let route: string;
	let warn: ReturnType<typeof spyOn>;

	beforeEach(async () => {
		({ env, queued } = await relayFixture());
		const inbound = incoming("sender@example.com", "j-7k9m@drop.test");
		await handleEmail(inbound.message, env, makeCtx());
		route = queued[0].from;
		queued.length = 0;
		warn = spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warn.mockRestore();
	});

	async function reply(
		envelope: string,
		fromHeader: string | null,
		extraHeaders: string[] = [],
		to = route,
	): Promise<IncomingEmail> {
		const mail = incoming(envelope, to, "Re: Hello", fromHeader, extraHeaders);
		await handleEmail(mail.message, env, makeCtx());
		return mail;
	}

	function expectRelayed(mail: IncomingEmail): void {
		expect(mail.rejection()).toBeNull();
		expect(queued).toHaveLength(1);
		expect(queued[0]).toMatchObject({
			direction: "reply",
			from: "j-7k9m@drop.test",
			to: "sender@example.com",
		});
		expect(warn).not.toHaveBeenCalled();
	}

	// Refused at SMTP with the same reason as an unknown route, so a leaked
	// token's holder learns nothing, and never stored as an ordinary drop.
	function expectRefused(mail: IncomingEmail, reason: RegExp): void {
		expect(mail.rejection()).toBe("Invalid relay reply address");
		expect(queued).toEqual([]);
		expect(env.DB.raw.query("SELECT COUNT(*) AS count FROM drops").get()).toEqual({ count: 0 });
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0][0])).toMatch(reason);
	}

	test("a reply whose From header is the rule target is relayed", async () => {
		const mail = await reply(OWNER, `"Owner" <${OWNER}>`, [
			cloudflareAuth("dmarc=pass header.from=example.org", `spf=pass smtp.mailfrom=${OWNER}`),
		]);
		expectRelayed(mail);
	});

	test("the owner is matched case-insensitively, and against a display-name rule target", async () => {
		await env.DB.prepare("UPDATE drop_rules SET target = ?")
			.bind('"The Owner" <Owner@Example.org>')
			.run();
		expectRelayed(await reply("OWNER@example.ORG", "OWNER@EXAMPLE.ORG"));
	});

	test("a reply from anyone else is refused, never queued and never stored as a drop", async () => {
		const mail = await reply("attacker@example.net", "attacker@example.net", [
			cloudflareAuth(
				"dmarc=pass header.from=example.net",
				"spf=pass smtp.mailfrom=attacker@example.net",
			),
		]);
		expectRefused(mail, /not the mask owner/);
	});

	test("naming the owner in Reply-To or Sender does not make someone else the owner", async () => {
		const mail = await reply("attacker@example.net", "attacker@example.net", [
			`Reply-To: ${OWNER}`,
			`Sender: ${OWNER}`,
		]);
		expectRefused(mail, /not the mask owner/);
	});

	test("the owner's own envelope is enough when Cloudflare saw SPF pass for it", async () => {
		// A provider alias: the header From is not the owner, the account is.
		const mail = await reply(OWNER, '"Owner" <alias@owner-alias.example>', [
			cloudflareAuth(
				"dmarc=pass header.from=owner-alias.example",
				`spf=pass smtp.mailfrom=${OWNER}`,
			),
		]);
		expectRelayed(mail);
	});

	test("an owner envelope is refused when DMARC fails for the From header", async () => {
		const mail = await reply(OWNER, "alias@owner-alias.example", [
			cloudflareAuth(
				"dmarc=fail header.from=owner-alias.example policy.dmarc=none",
				`spf=pass smtp.mailfrom=${OWNER}`,
			),
		]);
		expectRefused(mail, /dmarc=fail/);
	});

	// The envelope is the attacker's to write, and DMARC judges the From header's
	// domain, which here the attacker owns. Without Cloudflare's SPF pass for the
	// envelope itself, nothing ties it to the owner.
	test.each([
		["no Authentication-Results", []],
		[
			"SPF softfail for the envelope",
			[
				cloudflareAuth(
					"dmarc=pass header.from=attacker.example",
					`spf=softfail smtp.mailfrom=${OWNER}`,
				),
			],
		],
		["SPF pass for the HELO name only", [cloudflareAuth("spf=pass smtp.helo=mx.attacker.example")]],
		[
			"SPF pass for another envelope",
			[cloudflareAuth("spf=pass smtp.mailfrom=bounce@attacker.example")],
		],
		[
			"SPF pass only in a later field the sender wrote",
			[
				cloudflareAuth(`spf=softfail smtp.mailfrom=${OWNER}`),
				`Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=${OWNER}`,
			],
		],
	])("an owner envelope with no SPF pass behind it is refused (%s)", async (_, headers) => {
		const mail = await reply(OWNER, '"Owner" <someone@attacker.example>', headers);
		expectRefused(mail, /SPF/);
	});

	test("a From header naming the owner is refused when Cloudflare's DMARC verdict is fail", async () => {
		const mail = await reply("bounce@attacker.example", `"Owner" <${OWNER}>`, [
			cloudflareAuth(
				"dmarc=fail header.from=example.org policy.dmarc=none",
				"spf=pass smtp.mailfrom=bounce@attacker.example",
			),
			// Only the first field is Cloudflare's; this one is the sender's own.
			"Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=example.org",
		]);
		expectRefused(mail, /dmarc=fail/);
	});

	test("a DMARC pass is not required: an owner domain with no DMARC record still replies", async () => {
		const mail = await reply(OWNER, OWNER, [
			cloudflareAuth("dmarc=none header.from=example.org", `spf=pass smtp.mailfrom=${OWNER}`),
		]);
		expectRelayed(mail);
	});

	test("a mask whose relay rule is gone refuses replies instead of storing them", async () => {
		await env.DB.prepare("UPDATE drop_rules SET enabled = 0").run();
		expectRefused(await reply(OWNER, OWNER), /no relay rule/);
	});

	test("a legacy route inside its cutoff is held to the same owner check", async () => {
		env.RELAY_LEGACY_REPLY_UNTIL = "2999-01-01T00:00:00Z";
		const legacy = buildLegacyRelayAddress("sender@example.com", "j-7k9m", "drop.test");
		expectRefused(
			await reply("attacker@example.net", "attacker@example.net", [], legacy),
			/not the mask owner/,
		);
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

	// The owner only ever sees reply+<token>, so a Reply-To that sends their answer
	// somewhere other than the author has to be said out loud in the one place
	// they do see: the display name.
	test("a Reply-To header wins over From, and the label says where replies go", async () => {
		const { relayed, sender } = await relay('"Pat" <pat@example.com>', [
			"Reply-To: pat.replies@example.com",
		]);

		expect(sender).toBe("pat.replies@example.com");
		expect(rawHeader(relayed.rawEmail, "From")).toBe(
			`"Pat (via j-7k9m@drop.test, replies go to pat.replies@example.com)" <${relayed.from}>`,
		);
	});

	test("an unnamed sender is labelled with the From header address, never the envelope", async () => {
		const { relayed } = await relay("pat@example.com", ["Reply-To: help@example.com"]);

		expect(rawHeader(relayed.rawEmail, "From")).toBe(
			`"pat@example.com (via j-7k9m@drop.test, replies go to help@example.com)" <${relayed.from}>`,
		);
	});

	test("a Reply-To naming the From address, in any case, adds no note", async () => {
		const { relayed, sender } = await relay('"Pat" <pat@example.com>', [
			"Reply-To: Pat@Example.COM",
		]);

		expect(sender).toBe("Pat@Example.COM");
		expect(rawHeader(relayed.rawEmail, "From")).toBe(
			`"Pat (via j-7k9m@drop.test)" <${relayed.from}>`,
		);
	});

	test("a Reply-To beside an unusable From is noted against the envelope label", async () => {
		const { relayed, sender } = await relay("<>", ["Reply-To: help@example.com"]);

		expect(sender).toBe("help@example.com");
		expect(rawHeader(relayed.rawEmail, "From")).toBe(
			`"${BOUNCE} (via j-7k9m@drop.test, replies go to help@example.com)" <${relayed.from}>`,
		);
	});

	// The domain is what decides who receives the reply, so a cut address keeps
	// its end. Both halves are capped, so the sender cannot stretch the From line.
	test("a long Reply-To is cut from the front, and the From line stays bounded", async () => {
		const longReplyTo = `${"a".repeat(150)}@${"b".repeat(60)}.evil.example`;
		const { relayed, sender } = await relay(`"${"N".repeat(200)}" <pat@example.com>`, [
			`Reply-To: ${longReplyTo}`,
		]);

		expect(sender).toBe(longReplyTo);
		expect(rawHeader(relayed.rawEmail, "From")).toBe(
			`"${"N".repeat(64)} (via j-7k9m@drop.test, replies go to ...${longReplyTo.slice(-61)})" <${relayed.from}>`,
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
