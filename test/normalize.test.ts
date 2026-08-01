import { describe, expect, test } from "bun:test";
import { normalizeInbox, slugifyFilename } from "../src/lib/normalize";

// normalizeInbox is the routing key: every channel (email, web, API) funnels
// through it, so two inputs that collapse to the same name land in the same
// box. That is deliberate for gmail-style dots, and a leak if it over-collapses.

describe("normalizeInbox", () => {
	test("passes a already-valid name through unchanged", () => {
		expect(normalizeInbox("lisa")).toBe("lisa");
		expect(normalizeInbox("shop-returns")).toBe("shop-returns");
		expect(normalizeInbox("a1")).toBe("a1");
	});

	test("lowercases", () => {
		expect(normalizeInbox("Lisa")).toBe("lisa");
		expect(normalizeInbox("MR-GRAY")).toBe("mr-gray");
	});

	test("strips dots, gmail-style", () => {
		expect(normalizeInbox("mr.gray")).toBe("mrgray");
		expect(normalizeInbox("m.r.g.r.a.y")).toBe("mrgray");
		// The documented consequence: dotted and undotted are the SAME box.
		expect(normalizeInbox("mr.gray")).toBe(normalizeInbox("mrgray"));
	});

	test("converts underscores to hyphens", () => {
		expect(normalizeInbox("shop_returns")).toBe("shop-returns");
		expect(normalizeInbox("a_b_c")).toBe("a-b-c");
	});

	test("strips characters outside a-z 0-9 hyphen", () => {
		expect(normalizeInbox("li$sa!")).toBe("lisa");
		expect(normalizeInbox("lisa@frst.dev")).toBe("lisafrstdev");
		expect(normalizeInbox("über")).toBe("ber");
	});

	test("collapses consecutive hyphens and trims them from both ends", () => {
		expect(normalizeInbox("a--b")).toBe("a-b");
		expect(normalizeInbox("a-----b")).toBe("a-b");
		expect(normalizeInbox("-lisa-")).toBe("lisa");
		expect(normalizeInbox("--lisa--")).toBe("lisa");
	});

	test("rejects a name that starts with a digit", () => {
		expect(normalizeInbox("1lisa")).toBeNull();
		expect(normalizeInbox("2024-launch")).toBeNull();
		// Even when the digit only becomes leading after stripping.
		expect(normalizeInbox("-1lisa")).toBeNull();
	});

	test("rejects a name that normalizes to nothing", () => {
		expect(normalizeInbox("")).toBeNull();
		expect(normalizeInbox("...")).toBeNull();
		expect(normalizeInbox("---")).toBeNull();
		expect(normalizeInbox("!!!")).toBeNull();
	});

	test("accepts 64 characters and rejects 65", () => {
		expect(normalizeInbox("a".repeat(64))).toBe("a".repeat(64));
		expect(normalizeInbox("a".repeat(65))).toBeNull();
	});

	test("URL-decodes before normalizing", () => {
		expect(normalizeInbox("mr%2Dgray")).toBe("mr-gray");
		expect(normalizeInbox("shop%20returns")).toBe("shopreturns");
	});

	test("returns null on malformed percent-encoding instead of throwing", () => {
		expect(normalizeInbox("%")).toBeNull();
		expect(normalizeInbox("lisa%ZZ")).toBeNull();
	});

	test("is idempotent -- normalizing a normalized name is a no-op", () => {
		for (const raw of ["Mr.Gray", "shop_returns", "--LISA--", "li$sa", "a--b"]) {
			const once = normalizeInbox(raw);
			expect(once).not.toBeNull();
			expect(normalizeInbox(once as string)).toBe(once as string);
		}
	});

	test("path traversal cannot survive normalization", () => {
		// Inbox names are concatenated into R2 keys, so this matters.
		expect(normalizeInbox("../../etc/passwd")).toBe("etcpasswd");
		expect(normalizeInbox("..")).toBeNull();
		expect(normalizeInbox("a/b")).toBe("ab");
	});
});

describe("slugifyFilename", () => {
	test("the documented examples", () => {
		expect(slugifyFilename("Z Profile.jpg")).toBe("z-profile.jpg");
		expect(slugifyFilename("résumé.docx")).toBe("resume.docx");
		expect(slugifyFilename("Ärende Ö.pdf")).toBe("arende-o.pdf");
		expect(slugifyFilename("Z Profile (Final).jpg")).toBe("z-profile-final.jpg");
		expect(slugifyFilename("INVOICE_2024_03.PDF")).toBe("invoice-2024-03.pdf");
		expect(slugifyFilename("björk björk.mp3")).toBe("bjork-bjork.mp3");
	});

	test("romanizes the special-case char map, which NFD alone cannot handle", () => {
		// ß and ø do not decompose to an ASCII base character.
		expect(slugifyFilename("straße.txt")).toBe("strasse.txt");
		expect(slugifyFilename("smørrebrød.txt")).toBe("smorrebrod.txt");
		expect(slugifyFilename("æther.txt")).toBe("aether.txt");
	});

	test("lowercases the extension and preserves it", () => {
		expect(slugifyFilename("Report.PDF")).toBe("report.pdf");
		expect(slugifyFilename("archive.TAR.GZ")).toBe("archivetar.gz");
	});

	test("a file with no extension keeps none", () => {
		expect(slugifyFilename("Makefile")).toBe("makefile");
		expect(slugifyFilename("My Notes")).toBe("my-notes");
	});

	test("a dotfile is treated as a name, not an extension", () => {
		// lastIndexOf(".") is 0, and hasExt requires > 0.
		expect(slugifyFilename(".gitignore")).toBe("gitignore");
	});

	test("falls back to 'file' when the name slugifies to nothing", () => {
		expect(slugifyFilename("中文.pdf")).toBe("file.pdf");
		expect(slugifyFilename("!!!.txt")).toBe("file.txt");
		expect(slugifyFilename("---.txt")).toBe("file.txt");
	});

	test("collapses hyphens and trims them from the name", () => {
		expect(slugifyFilename("a   b.txt")).toBe("a-b.txt");
		expect(slugifyFilename("-lead and trail-.txt")).toBe("lead-and-trail.txt");
	});

	test("strips path separators from the NAME", () => {
		expect(slugifyFilename("a/b/c.txt")).toBe("abc.txt");
		expect(slugifyFilename("..\\..\\win.ini")).toBe("win.ini");
	});

	test("strips path separators from the EXTENSION too", () => {
		// Regression: the extension used to be `raw.slice(lastDot)` verbatim, so
		// everything after the last dot -- separators included -- landed in the R2
		// key. "../../etc/passwd" produced "file./etc/passwd".
		expect(slugifyFilename("../../etc/passwd")).toBe("file.etcpasswd");
		expect(slugifyFilename("a./x/y/z")).toBe("a.xyz");
		// lastIndexOf(".") lands inside the "/../", so "report.pdf/." is the name
		// and "/evil" is the extension -- both get stripped.
		expect(slugifyFilename("report.pdf/../evil")).toBe("reportpdf.evil");
	});

	test("drops the dot entirely when nothing survives the extension strip", () => {
		expect(slugifyFilename("notes./")).toBe("notes");
		expect(slugifyFilename("notes.")).toBe("notes");
	});

	test("output only ever contains a-z, 0-9, hyphen and a single dot", () => {
		for (const raw of [
			"Ärende Ö.pdf",
			"straße (v2).TXT",
			"../x.png",
			"n@me #1.jpeg",
			"中文.pdf",
			"no-ext",
			"../../etc/passwd",
			"a./x/y/z",
		]) {
			expect(slugifyFilename(raw)).toMatch(/^[a-z0-9-]+(\.[a-z0-9]+)?$/);
		}
	});
});
