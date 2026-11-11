import { describe, expect, test } from "bun:test";
import { handleEmail } from "../src/email-handler";
import {
	type AuthResult,
	CLOUDFLARE_AUTH_SERVICE,
	parseSenderAuth,
	type SenderAuthResults,
} from "../src/lib/mail-auth";
import { makeBucket, makeCtx, makeEnv } from "./helpers/env";

const CLOUDFLARE_HEADER =
	"mx.cloudflare.net; dkim=pass header.d=example.com header.s=mail; " +
	"dmarc=none header.from=example.com policy.dmarc=none; " +
	"spf=pass smtp.mailfrom=sender@example.com";

const PASS: SenderAuthResults = {
	authserv: CLOUDFLARE_AUTH_SERVICE,
	spf: [{ result: "pass", props: { "smtp.mailfrom": "sender@example.com" } }],
	dkim: [{ result: "pass", props: { "header.d": "example.com", "header.s": "mail" } }],
	dmarc: [{ result: "none", props: { "header.from": "example.com", "policy.dmarc": "none" } }],
};

const MAILFROM =
	"prod-mta-06.86fed9dcd6ce47d88eb4faa636d7c610.1a1c74443af000a63e@swg.mail.modelalert.ai";

// Verbatim from a production message, folds included. Two SPF results: the
// first is the HELO check, the second the MAIL FROM check.
const PRODUCTION_HEADER = [
	"mx.cloudflare.net;",
	"\tdkim=pass header.d=mail.modelalert.ai header.s=selector1 header.b=XjV4oj8Y;",
	"\tdmarc=pass header.from=mail.modelalert.ai policy.dmarc=quarantine;",
	"\tspf=none (mx.cloudflare.net: no SPF records found for postmaster@prod-mta-06-05.swg-srv.net) smtp.helo=prod-mta-06-05.swg-srv.net;",
	`\tspf=pass (mx.cloudflare.net: domain of ${MAILFROM} designates 185.255.28.41 as permitted sender) smtp.mailfrom=${MAILFROM};`,
	"\tarc=none smtp.remote-ip=185.255.28.41",
].join("\r\n");

const PRODUCTION: SenderAuthResults = {
	authserv: CLOUDFLARE_AUTH_SERVICE,
	spf: [
		{ result: "none", props: { "smtp.helo": "prod-mta-06-05.swg-srv.net" } },
		{ result: "pass", props: { "smtp.mailfrom": MAILFROM } },
	],
	dkim: [
		{
			result: "pass",
			props: { "header.d": "mail.modelalert.ai", "header.s": "selector1", "header.b": "XjV4oj8Y" },
		},
	],
	dmarc: [
		{
			result: "pass",
			props: { "header.from": "mail.modelalert.ai", "policy.dmarc": "quarantine" },
		},
	],
};

const bare = (result: string): AuthResult => ({ result, props: {} });

describe("parseSenderAuth", () => {
	test("records a captured Cloudflare-shaped field", () => {
		expect(parseSenderAuth(CLOUDFLARE_HEADER)).toEqual(PASS);
	});

	test("parses a production field with the identity of every result attached", () => {
		expect(parseSenderAuth(PRODUCTION_HEADER)).toEqual(PRODUCTION);
	});

	test("tells the MAIL FROM SPF result apart from the HELO one", () => {
		const auth = parseSenderAuth(PRODUCTION_HEADER);
		const spfFor = (prop: string) =>
			auth?.spf.filter((entry) => prop in entry.props).map((entry) => entry.result);

		expect(spfFor("smtp.mailfrom")).toEqual(["pass"]);
		expect(spfFor("smtp.helo")).toEqual(["none"]);
		expect(auth?.dkim.map((entry) => [entry.result, entry.props["header.d"]])).toEqual([
			["pass", "mail.modelalert.ai"],
		]);
		expect(auth?.dmarc.map((entry) => [entry.result, entry.props["header.from"]])).toEqual([
			["pass", "mail.modelalert.ai"],
		]);
	});

	test("accepts result and Authentication-Results versions", () => {
		expect(
			parseSenderAuth("mx.cloudflare.net 1; spf / 1 = softfail; dkim=temperror; dmarc = permerror"),
		).toEqual({
			authserv: CLOUDFLARE_AUTH_SERVICE,
			spf: [bare("softfail")],
			dkim: [bare("temperror")],
			dmarc: [bare("permerror")],
		});
	});

	test("preserves repeated results in field order", () => {
		expect(
			parseSenderAuth(
				"mx.cloudflare.net; dkim=pass header.d=a.example; dkim=fail header.d=b.example",
			),
		).toEqual({
			authserv: CLOUDFLARE_AUTH_SERVICE,
			spf: [],
			dkim: [
				{ result: "pass", props: { "header.d": "a.example" } },
				{ result: "fail", props: { "header.d": "b.example" } },
			],
			dmarc: [],
		});
	});

	test("does not promote result-like text inside comments or quoted values", () => {
		const header =
			'mx.cloudflare.net; spf=fail (sender=x; dmarc=pass); dkim=fail reason="x; dmarc=pass"; dmarc=fail';
		expect(parseSenderAuth(header)).toEqual({
			authserv: CLOUDFLARE_AUTH_SERVICE,
			spf: [bare("fail")],
			dkim: [{ result: "fail", reason: "x; dmarc=pass", props: {} }],
			dmarc: [bare("fail")],
		});
	});

	test("does not let a comment or quoted value manufacture a property", () => {
		const header =
			"mx.cloudflare.net; spf=fail (smtp.mailfrom=forged@example.com) smtp.helo=relay.example; " +
			'dkim=fail reason="header.d=forged.example" header.d=real.example; ' +
			'dmarc=fail header.from="real.example policy.dmarc=none"';
		expect(parseSenderAuth(header)).toEqual({
			authserv: CLOUDFLARE_AUTH_SERVICE,
			spf: [{ result: "fail", props: { "smtp.helo": "relay.example" } }],
			dkim: [
				{
					result: "fail",
					reason: "header.d=forged.example",
					props: { "header.d": "real.example" },
				},
			],
			dmarc: [{ result: "fail", props: { "header.from": "real.example policy.dmarc=none" } }],
		});
	});

	test("unquotes a quoted value and keeps a quoted local-part verbatim", () => {
		const header =
			'mx.cloudflare.net; dmarc=pass header.from="example.com"; ' +
			'spf=pass smtp.mailfrom="first last"@example.com; ' +
			'dkim=pass header.d="a\\"b.example"';
		expect(parseSenderAuth(header)).toEqual({
			authserv: CLOUDFLARE_AUTH_SERVICE,
			spf: [{ result: "pass", props: { "smtp.mailfrom": '"first last"@example.com' } }],
			dkim: [{ result: "pass", props: { "header.d": 'a"b.example' } }],
			dmarc: [{ result: "pass", props: { "header.from": "example.com" } }],
		});
	});

	test("reads a comment as a separator between tokens, never as glue", () => {
		expect(
			parseSenderAuth(
				"mx.cloudflare.net; spf=pass(x)smtp.mailfrom=a@example.com(y)smtp.helo=h.example",
			),
		).toEqual({
			authserv: CLOUDFLARE_AUTH_SERVICE,
			spf: [
				{ result: "pass", props: { "smtp.mailfrom": "a@example.com", "smtp.helo": "h.example" } },
			],
			dkim: [],
			dmarc: [],
		});
	});

	test("accepts whitespace around the property dot and equals sign", () => {
		expect(parseSenderAuth("mx.cloudflare.net; spf=pass SMTP . MailFrom = a@example.com")).toEqual({
			authserv: CLOUDFLARE_AUTH_SERVICE,
			spf: [{ result: "pass", props: { "smtp.mailfrom": "a@example.com" } }],
			dkim: [],
			dmarc: [],
		});
	});

	test.each([
		["missing", null],
		["empty", ""],
		["no field separator", "mx.cloudflare.net dmarc=pass"],
		["different service", "sender.example; spf=pass; dkim=pass; dmarc=pass"],
		["lookalike suffix", "mx.cloudflare.net.evil; spf=pass; dkim=pass; dmarc=pass"],
		["lookalike prefix", "evil.mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass"],
		["different case", "MX.CLOUDFLARE.NET; dmarc=pass"],
		["unclosed comment", "mx.cloudflare.net; spf=pass (not closed"],
		["unclosed quote", 'mx.cloudflare.net; spf=pass reason="not closed'],
		["unexpected close", "mx.cloudflare.net; spf=pass )"],
		["malformed known result", "mx.cloudflare.net; spf==pass"],
		["comment inside a result", "mx.cloudflare.net; dkim=pa(x)ss"],
		["comment inside the authserv-id", "mx.cloud(x)flare.net; dmarc=pass"],
		["bare word after a result", "mx.cloudflare.net; spf=pass mailfrom"],
		["property without a value", "mx.cloudflare.net; spf=pass smtp.mailfrom="],
		["property without a ptype", "mx.cloudflare.net; spf=pass .mailfrom=a@example.com"],
		["repeated property", "mx.cloudflare.net; dkim=pass header.d=a.example header.d=b.example"],
		["repeated reason", "mx.cloudflare.net; dkim=fail reason=a reason=b"],
		["quoted value glued to the next token", 'mx.cloudflare.net; dmarc=pass header.from="a"x=y'],
		["oversized", `mx.cloudflare.net; dmarc=pass ${"x".repeat(16_384)}`],
	])("fails %s closed without throwing", (_case, header) => {
		expect(parseSenderAuth(header)).toBeNull();
	});
});

interface InboundOptions {
	authResults?: string[];
	fromHeader?: string;
	envelopeFrom?: string;
}

function inboundMessage(options: InboundOptions = {}): ForwardableEmailMessage {
	const fromHeader = options.fromHeader ?? "Sender <sender@example.com>";
	const envelopeFrom = options.envelopeFrom ?? "bounce@example.com";
	const authenticationHeaders = (options.authResults ?? []).map(
		(value) => `Authentication-Results: ${value}`,
	);
	const raw = [
		...authenticationHeaders,
		`From: ${fromHeader}`,
		"To: lisa@drop.test",
		"Subject: Authentication test",
		"Message-ID: <auth-test@example.com>",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"hello",
	].join("\r\n");
	const headers = new Headers({ "message-id": "<auth-test@example.com>" });
	for (const value of options.authResults ?? []) {
		// Fetch Headers reject CR/LF, so this copy is unfolded. The raw MIME
		// above keeps the folds, and that is what the handler parses.
		headers.append("authentication-results", value.replace(/\r\n(?=[ \t])/g, ""));
	}

	return {
		from: envelopeFrom,
		to: "lisa@drop.test",
		headers,
		raw: new Blob([raw]).stream(),
		rawSize: new TextEncoder().encode(raw).byteLength,
		setReject: () => {},
		forward: async () => ({ messageId: "forwarded" }),
		reply: async () => ({ messageId: "replied" }),
	};
}

interface StoredDrop {
	from_addr: string;
	metadata: {
		from_header: string | null;
		sender_auth: SenderAuthResults | null;
	};
}

async function storedDrop(options: InboundOptions = {}): Promise<StoredDrop> {
	const env = makeEnv({ BUCKET: makeBucket() });
	const ctx = makeCtx();
	await handleEmail(inboundMessage(options), env, ctx);
	await ctx.settle();

	const row = env.DB.raw.query("SELECT from_addr, metadata FROM drops LIMIT 1").get() as
		| { from_addr: string; metadata: string }
		| undefined;
	expect(row).toBeDefined();
	return {
		from_addr: row?.from_addr ?? "",
		metadata: JSON.parse(row?.metadata ?? "{}"),
	};
}

describe("inbound drop metadata", () => {
	test("stores only the first physical Cloudflare field", async () => {
		const drop = await storedDrop({
			authResults: [
				"mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail",
				"mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass",
			],
		});
		expect(drop.metadata.sender_auth).toEqual({
			authserv: CLOUDFLARE_AUTH_SERVICE,
			spf: [bare("fail")],
			dkim: [bare("fail")],
			dmarc: [bare("fail")],
		});
	});

	test("stores the production field with every identity through the MIME parser", async () => {
		const drop = await storedDrop({ authResults: [PRODUCTION_HEADER] });
		expect(drop.metadata.sender_auth).toEqual(PRODUCTION);
	});

	test("does not skip an untrusted first field for a trusted-looking later field", async () => {
		const drop = await storedDrop({
			authResults: ["sender.example; dmarc=pass", "mx.cloudflare.net; dmarc=pass"],
		});
		expect(drop.metadata.sender_auth).toBeNull();
	});

	test("distinguishes the envelope sender from the RFC From header", async () => {
		const drop = await storedDrop({
			authResults: [CLOUDFLARE_HEADER],
			envelopeFrom: "bounce@mailer.example",
			fromHeader: "Security <security@vendor.example>",
		});
		expect(drop.from_addr).toBe("bounce@mailer.example");
		expect(drop.metadata.from_header).toBe("Security <security@vendor.example>");
		expect(drop.metadata.sender_auth).toEqual(PASS);
	});

	test("stores missing authentication evidence as null without dropping the email", async () => {
		const drop = await storedDrop();
		expect(drop.metadata.sender_auth).toBeNull();
	});
});
