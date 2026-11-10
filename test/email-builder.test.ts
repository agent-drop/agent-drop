import { describe, expect, test } from "bun:test";
import {
	addressOf,
	bareContentId,
	MAX_HEADER_BYTES,
	MAX_HEADER_NAME_BYTES,
	MAX_HEADER_VALUE_BYTES,
	MAX_NON_X_HEADERS,
	MAX_RECIPIENTS,
	parseAddress,
	toEmailAttachment,
	toRecipients,
	validateHeaderValue,
	validateHeaders,
	validateMessageId,
	validateRecipients,
} from "../src/lib/email-builder";

describe("parseAddress", () => {
	test("a bare address stays a string", () => {
		expect(parseAddress("bob@example.com")).toBe("bob@example.com");
	});

	test("trims surrounding whitespace", () => {
		expect(parseAddress("  bob@example.com  ")).toBe("bob@example.com");
	});

	// EmailAddress.name is required, so an angle-bracket address with no display
	// name must NOT become { name: "", email } -- that puts `"" <bob@x>` on the wire.
	test("angle brackets with no display name collapse to the bare address", () => {
		expect(parseAddress("<bob@example.com>")).toBe("bob@example.com");
	});

	test("quoted display name is unwrapped", () => {
		expect(parseAddress('"Bob Loblaw" <bob@example.com>')).toEqual({
			name: "Bob Loblaw",
			email: "bob@example.com",
		});
	});

	test("unquoted display name works too", () => {
		expect(parseAddress("Bob Loblaw <bob@example.com>")).toEqual({
			name: "Bob Loblaw",
			email: "bob@example.com",
		});
	});

	test("a display name containing an @ does not confuse the split", () => {
		expect(parseAddress('"sender@old.com (via lisa@frst.dev)" <lisa@frst.dev>')).toEqual({
			name: "sender@old.com (via lisa@frst.dev)",
			email: "lisa@frst.dev",
		});
	});

	test("toRecipients maps a whole list", () => {
		expect(toRecipients(['"Bob" <bob@x.com>', "alice@x.com"])).toEqual([
			{ name: "Bob", email: "bob@x.com" },
			"alice@x.com",
		]);
	});
});

describe("addressOf", () => {
	test("reads through every address shape", () => {
		expect(addressOf("bob@x.com")).toBe("bob@x.com");
		expect(addressOf('"Bob" <bob@x.com>')).toBe("bob@x.com");
		expect(addressOf({ name: "Bob", email: "bob@x.com" })).toBe("bob@x.com");
	});
});

describe("validateRecipients", () => {
	test("rejects an empty recipient set", () => {
		expect(validateRecipients([], [], [])).toMatch(/at least one recipient/);
	});

	test("accepts a cc-only or bcc-only send", () => {
		expect(validateRecipients([], ["cc@x.com"], [])).toBeNull();
		expect(validateRecipients([], [], ["bcc@x.com"])).toBeNull();
	});

	test(`accepts exactly ${MAX_RECIPIENTS} combined`, () => {
		const addrs = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}@x.com`);
		expect(validateRecipients(addrs(20, "t"), addrs(20, "c"), addrs(10, "b"))).toBeNull();
	});

	test("rejects one over the cap, counting to + cc + bcc together", () => {
		const addrs = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}@x.com`);
		const error = validateRecipients(addrs(20, "t"), addrs(20, "c"), addrs(11, "b"));
		expect(error).toMatch(/too many recipients: 51/);
		expect(error).toContain(String(MAX_RECIPIENTS));
	});

	test("rejects a recipient that can inject another header line", () => {
		expect(validateRecipients(["safe@example.com\r\nBcc: stolen@example.com"], [], [])).toMatch(
			/control character/,
		);
	});
});

describe("header structure", () => {
	test("rejects CR, LF, NUL, tabs, and DEL without rejecting Unicode", () => {
		for (const control of ["\r", "\n", "\0", "\t", "\u007f"]) {
			expect(validateHeaderValue("subject", `safe${control}unsafe`)).toMatch(/control character/);
		}
		expect(validateHeaderValue("subject", "Résumé ✅")).toBeNull();
	});

	test("accepts one Message-ID token and rejects fragments or lists", () => {
		expect(validateMessageId("<one@example.com>")).toBeNull();
		for (const value of [
			"one@example.com",
			"<one>",
			"<one@example.com> <two@example.com>",
			"<one@example.com>\r\nBcc: stolen@example.com",
		]) {
			expect(validateMessageId(value)).not.toBeNull();
		}
	});
});

describe("validateHeaders", () => {
	test("accepts the threading headers this codebase actually sets", () => {
		expect(validateHeaders({ "In-Reply-To": "<a@b.com>", References: "<a@b.com>" })).toBeNull();
	});

	test("accepts an empty header set", () => {
		expect(validateHeaders({})).toBeNull();
	});

	test(`rejects more than ${MAX_NON_X_HEADERS} non-X- headers`, () => {
		const headers: Record<string, string> = {};
		for (let i = 0; i <= MAX_NON_X_HEADERS; i++) headers[`Header-${i}`] = "v";
		expect(validateHeaders(headers)).toMatch(/too many custom headers: 21/);
	});

	test("X- headers do not count toward that cap", () => {
		const headers: Record<string, string> = {};
		for (let i = 0; i < 40; i++) headers[`X-Thing-${i}`] = "v";
		expect(validateHeaders(headers)).toBeNull();
	});

	test("the X- exemption is case-insensitive", () => {
		const headers: Record<string, string> = {};
		for (let i = 0; i <= MAX_NON_X_HEADERS; i++) headers[`x-thing-${i}`] = "v";
		expect(validateHeaders(headers)).toBeNull();
	});

	test("rejects an over-long header value", () => {
		expect(validateHeaders({ "X-Big": "v".repeat(MAX_HEADER_VALUE_BYTES + 1) })).toMatch(
			/header value too long/,
		);
	});

	test("rejects an over-long header name", () => {
		expect(validateHeaders({ [`X-${"n".repeat(MAX_HEADER_NAME_BYTES)}`]: "v" })).toMatch(
			/header name too long/,
		);
	});

	test("rejects a header set over the total byte budget", () => {
		const headers: Record<string, string> = {};
		// Each entry is well under the per-header caps; together they blow the 16KB total.
		for (let i = 0; i < 16; i++) headers[`X-Chunk-${i}`] = "v".repeat(MAX_HEADER_VALUE_BYTES - 1);
		const error = validateHeaders(headers);
		expect(error).toMatch(/custom headers too large/);
		expect(error).toContain(String(MAX_HEADER_BYTES));
	});

	test("measures bytes, not characters", () => {
		// A 4-byte emoji repeated past the value cap is under it by .length.
		const value = "\u{1F600}".repeat(600); // 600 chars, 2400 bytes
		expect(validateHeaders({ "X-Emoji": value })).toMatch(/header value too long/);
	});

	test("rejects controls before measuring otherwise-short headers", () => {
		expect(validateHeaders({ "X-Safe": "ok\r\nBcc: stolen@example.com" })).toMatch(
			/control character/,
		);
	});
});

describe("bareContentId", () => {
	test("strips a single set of angle brackets", () => {
		expect(bareContentId("<logo123>")).toBe("logo123");
	});

	test("leaves a bare id alone", () => {
		expect(bareContentId("logo123")).toBe("logo123");
	});

	test("handles a cid with an @ in it", () => {
		expect(bareContentId("<part1.abc@mail.example.com>")).toBe("part1.abc@mail.example.com");
	});
});

describe("toEmailAttachment", () => {
	const bytes = new Uint8Array([1, 2, 3]).buffer;

	test("a plain attachment carries no contentId", () => {
		expect(
			toEmailAttachment({ filename: "a.pdf", contentType: "application/pdf", content: bytes }),
		).toEqual({
			disposition: "attachment",
			filename: "a.pdf",
			type: "application/pdf",
			content: bytes,
		});
	});

	test("an inline attachment with a cid keeps it, normalised", () => {
		expect(
			toEmailAttachment({
				filename: "logo.png",
				contentType: "image/png",
				content: bytes,
				inline: true,
				cid: "<logo>",
			}),
		).toEqual({
			disposition: "inline",
			contentId: "logo",
			filename: "logo.png",
			type: "image/png",
			content: bytes,
		});
	});

	test("inline without a cid is not representable, so it degrades", () => {
		const result = toEmailAttachment({
			filename: "logo.png",
			contentType: "image/png",
			content: bytes,
			inline: true,
		});
		expect(result.disposition).toBe("attachment");
		expect(result.contentId).toBeUndefined();
	});

	test("content is passed through by identity, never re-encoded", () => {
		const result = toEmailAttachment({ filename: "a", contentType: "text/plain", content: bytes });
		expect(result.content).toBe(bytes);
	});
});
