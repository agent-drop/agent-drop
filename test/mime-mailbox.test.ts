import { describe, expect, test } from "bun:test";
import PostalMime from "postal-mime";
import { buildRawEmail, formatMailbox, sanitizeDisplayName } from "../src/lib/mime";
import { viaDisplayName } from "../src/lib/relay";

/** Parse a one-header message so the decoder, not a regex, says what the From means. */
async function parseFrom(fromHeader: string) {
	const parsed = await new PostalMime().parse(`From: ${fromHeader}\r\nSubject: s\r\n\r\nbody`);
	return parsed.from;
}

describe("sanitizeDisplayName", () => {
	test("turns line breaks into spaces and drops what can escape a quoted-string", () => {
		expect(sanitizeDisplayName('A "B"\r\nBcc: c@x.test\\ <d@x.test>\t\0E')).toBe(
			"A B Bcc: c@x.test d@x.test E",
		);
	});

	test("leaves an ordinary name, non-ASCII included, alone", () => {
		expect(sanitizeDisplayName("Ärende Ö")).toBe("Ärende Ö");
		expect(sanitizeDisplayName("O'Brien, Pat (Sales)")).toBe("O'Brien, Pat (Sales)");
	});
});

describe("formatMailbox", () => {
	test("an ASCII name rides in a quoted-string", () => {
		expect(formatMailbox("Lisa Smith", "lisa@drop.test")).toBe('"Lisa Smith" <lisa@drop.test>');
	});

	test("a name that sanitizes to nothing leaves the bare address, not an empty phrase", () => {
		expect(formatMailbox(' "" \r\n ', "lisa@drop.test")).toBe("lisa@drop.test");
	});

	test("a non-ASCII name is an unquoted encoded-word that decodes back", async () => {
		const header = formatMailbox("Ärende Ö", "lisa@drop.test");
		expect(header).toBe("=?UTF-8?B?w4RyZW5kZSDDlg==?= <lisa@drop.test>");
		expect(await parseFrom(header)).toEqual({ name: "Ärende Ö", address: "lisa@drop.test" });
	});

	// One encoded-word may be 75 characters at most (RFC 2047 sec. 2). A long name
	// must split into several, and never inside a multi-byte character.
	test("a long non-ASCII name splits into legal encoded-words on folded lines", async () => {
		const name = "Åsa Öberg-Ärlemalm 😀 ".repeat(6).trim();
		const header = formatMailbox(name, "lisa@drop.test");

		const words = header.match(/=\?UTF-8\?B\?[^?]*\?=/g) ?? [];
		expect(words.length).toBeGreaterThan(1);
		for (const word of words) expect(word.length).toBeLessThanOrEqual(75);
		for (const line of header.split("\r\n").slice(1)) expect(line).toStartWith(" ");
		// Each word decodes to whole characters on its own: a split character would
		// decode to U+FFFD and fail the round trip back to the same bytes.
		for (const word of words) {
			const bytes = Buffer.from(word.slice(10, -2), "base64");
			expect(Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)).toBe(true);
		}
		expect(await parseFrom(header)).toEqual({ name, address: "lisa@drop.test" });
	});

	test("buildRawEmail writes it as one From header the address can still be found in", () => {
		const raw = buildRawEmail({
			from: formatMailbox('x <evil@attacker.test> "', "reply+abc@drop.test"),
			to: "owner@example.org",
			subject: "s",
			textBody: "b",
		});
		// The Message-ID domain is taken from the address inside the angle brackets.
		expect(raw).toMatch(/^Message-ID: <[^@]+@drop\.test>$/m);
		expect(raw).toContain('From: "x evil@attacker.test" <reply+abc@drop.test>\r\n');
	});
});

describe("viaDisplayName", () => {
	test("prefers the name, falls back to the address", () => {
		expect(viaDisplayName({ name: "Lisa Smith", address: "lisa@x.test" }, "j-1@drop.test")).toBe(
			"Lisa Smith (via j-1@drop.test)",
		);
		expect(viaDisplayName({ name: "", address: "bob@x.test" }, "j-1@drop.test")).toBe(
			"bob@x.test (via j-1@drop.test)",
		);
		expect(viaDisplayName({ name: ' "" ', address: "bob@x.test" }, "j-1@drop.test")).toBe(
			"bob@x.test (via j-1@drop.test)",
		);
	});

	test("caps the sender half so a huge name cannot push From past the line limit", () => {
		const label = viaDisplayName({ name: "A".repeat(5000), address: "a@x.test" }, "j-1@drop.test");
		expect(label).toBe(`${"A".repeat(64)} (via j-1@drop.test)`);
	});

	test("the cap counts characters, so it never splits an emoji in half", () => {
		const label = viaDisplayName({ name: "😀".repeat(100), address: "a@x.test" }, "j-1@drop.test");
		expect(label).toBe(`${"😀".repeat(64)} (via j-1@drop.test)`);
	});
});
