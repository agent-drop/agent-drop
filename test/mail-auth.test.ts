import { describe, expect, test } from "bun:test";
import { handleEmail } from "../src/email-handler";
import {
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
	spf: ["pass"],
	dkim: ["pass"],
	dmarc: ["none"],
};

describe("parseSenderAuth", () => {
	test("records a captured Cloudflare-shaped field", () => {
		expect(parseSenderAuth(CLOUDFLARE_HEADER)).toEqual(PASS);
	});

	test("accepts result and Authentication-Results versions", () => {
		expect(
			parseSenderAuth("mx.cloudflare.net 1; spf / 1 = softfail; dkim=temperror; dmarc = permerror"),
		).toEqual({
			authserv: CLOUDFLARE_AUTH_SERVICE,
			spf: ["softfail"],
			dkim: ["temperror"],
			dmarc: ["permerror"],
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
			dkim: ["pass", "fail"],
			dmarc: [],
		});
	});

	test("does not promote result-like text inside comments or quoted values", () => {
		const header =
			'mx.cloudflare.net; spf=fail (sender=x; dmarc=pass); dkim=fail reason="x; dmarc=pass"; dmarc=fail';
		expect(parseSenderAuth(header)).toEqual({
			authserv: CLOUDFLARE_AUTH_SERVICE,
			spf: ["fail"],
			dkim: ["fail"],
			dmarc: ["fail"],
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
		headers.append("authentication-results", value);
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
			spf: ["fail"],
			dkim: ["fail"],
			dmarc: ["fail"],
		});
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
