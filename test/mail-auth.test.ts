import { describe, expect, test } from "bun:test";
import { parseAuthResults } from "../src/lib/mail-auth";

/** The header Cloudflare actually attached to a real message, trimmed. */
const CLOUDFLARE =
	"mx.cloudflare.net; dkim=pass header.d=sawalha.com header.s=google header.b=E6NQ7nnl; " +
	"dmarc=none header.from=sawalha.com policy.dmarc=none; " +
	"spf=pass (mx.cloudflare.net: domain of ziad@sawalha.com designates 2607:f8b0::1 as permitted sender) " +
	"smtp.mailfrom=ziad@sawalha.com";

describe("parseAuthResults", () => {
	test("lifts every verdict out of a real Cloudflare header", () => {
		expect(parseAuthResults(CLOUDFLARE)).toEqual({
			authserv: "mx.cloudflare.net",
			spf: "pass",
			dkim: "pass",
			dmarc: "none",
		});
	});

	test("a missing header is not a passing one", () => {
		expect(parseAuthResults(null)).toEqual({
			authserv: null,
			spf: null,
			dkim: null,
			dmarc: null,
		});
		expect(parseAuthResults("")).toEqual({
			authserv: null,
			spf: null,
			dkim: null,
			dmarc: null,
		});
	});

	test("verdicts other than pass survive intact", () => {
		expect(parseAuthResults("mx.cloudflare.net; spf=fail; dkim=none; dmarc=fail")).toEqual({
			authserv: "mx.cloudflare.net",
			spf: "fail",
			dkim: "none",
			dmarc: "fail",
		});
	});

	// The property the whole record depends on.
	test("a sender-supplied second field cannot overwrite the MTA's verdict", () => {
		const forged = `${"mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail"}, evil.example; spf=pass; dkim=pass; dmarc=pass`;
		expect(parseAuthResults(forged)).toEqual({
			authserv: "mx.cloudflare.net",
			spf: "fail",
			dkim: "fail",
			dmarc: "fail",
		});
	});

	test("an unparseable header yields nulls rather than guesses", () => {
		expect(parseAuthResults("garbage without any verdicts")).toEqual({
			authserv: "garbage without any verdicts",
			spf: null,
			dkim: null,
			dmarc: null,
		});
	});
});
