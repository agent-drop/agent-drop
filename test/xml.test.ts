import { describe, expect, test } from "bun:test";
import {
	readListedParts,
	readUploadId,
	renderCompleteBody,
	type UploadPart,
} from "../src/lib/s3-xml";
import { childText, children, escapeXml, parseXml, XmlParseError } from "../src/lib/xml";

describe("parseXml", () => {
	test("elements, nesting and text", () => {
		const root = parseXml("<a><b>one</b><b>two</b><c/></a>");
		expect(root.name).toBe("a");
		expect(children(root, "b").map((n) => n.text)).toEqual(["one", "two"]);
		expect(children(root, "c")).toHaveLength(1);
		expect(children(root, "c")[0].text).toBe("");
	});

	test("an element's text excludes its descendants'", () => {
		// The old regexes had no notion of this at all: `<ETag>(.+?)</ETag>` would
		// happily reach across a nested element.
		const root = parseXml("<a>outer<b>inner</b>tail</a>");
		expect(root.text).toBe("outertail");
		expect(childText(root, "b")).toBe("inner");
	});

	test("attributes, both quote styles, and namespace prefixes", () => {
		const root = parseXml(
			`<r xmlns="http://s3.amazonaws.com/doc/2006-03-01/" n='1'><ns:x a="b"/></r>`,
		);
		expect(root.attrs.xmlns).toBe("http://s3.amazonaws.com/doc/2006-03-01/");
		expect(root.attrs.n).toBe("1");
		expect(root.children[0].name).toBe("ns:x");
		expect(root.children[0].attrs.a).toBe("b");
	});

	test("declarations, comments and doctypes are skipped", () => {
		const root = parseXml(
			`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE r><!-- note --><r>x</r>`,
		);
		expect(root.name).toBe("r");
		expect(root.text).toBe("x");
	});

	test("CDATA is taken literally", () => {
		expect(parseXml("<r><![CDATA[a < b & c]]></r>").text).toBe("a < b & c");
	});

	test("entities are decoded, including numeric references", () => {
		const root = parseXml("<r>&lt;&gt;&amp;&quot;&apos;&#65;&#x42;</r>");
		expect(root.text).toBe(`<>&"'AB`);
	});

	test("an unknown entity is left alone rather than dropped", () => {
		expect(parseXml("<r>&nbsp;</r>").text).toBe("&nbsp;");
	});

	test("whitespace inside tags is tolerated", () => {
		// `<Part >` matched nothing under the old `<Part>` regex.
		const root = parseXml("<r ><b  a = 'x' >t</b\n></r >");
		expect(children(root, "b")[0].attrs.a).toBe("x");
	});

	const malformed: [string, string][] = [
		["a mismatched closing tag", "<a><b></a></b>"],
		["an unclosed element", "<a><b>x</a>"],
		["a stray closing tag", "<a></a></b>"],
		["an unterminated tag", "<a"],
		["an unquoted attribute", "<a b=c/>"],
		["an attribute with no value", "<a b/>"],
		["nothing at all", ""],
		["text with no element", "just words"],
		["two roots", "<a/><b/>"],
		["unterminated CDATA", "<a><![CDATA[x</a>"],
		["an unterminated comment", "<a><!-- x</a>"],
	];

	for (const [what, input] of malformed) {
		test(`rejects ${what}`, () => {
			expect(() => parseXml(input)).toThrow(XmlParseError);
		});
	}
});

describe("escapeXml", () => {
	test("escapes only what element content requires", () => {
		expect(escapeXml(`a & b < c > d "e" 'f'`)).toBe(`a &amp; b &lt; c &gt; d "e" 'f'`);
	});

	test("round-trips through the parser", () => {
		const value = `weird & <stuff> "quoted"`;
		expect(parseXml(`<a>${escapeXml(value)}</a>`).text).toBe(value);
	});
});

describe("readUploadId", () => {
	const ok = `<?xml version="1.0" encoding="UTF-8"?>
		<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
			<Bucket>agent-drop-storage</Bucket>
			<Key>drops/lisa/abc/uploads/big.zip</Key>
			<UploadId>ABC-123_xyz</UploadId>
		</InitiateMultipartUploadResult>`;

	test("reads the id and trims the pretty-printing", () => {
		expect(readUploadId(ok)).toBe("ABC-123_xyz");
	});

	test("refuses an id from the wrong document", () => {
		// An <Error> body carrying an <UploadId> used to satisfy the old regex.
		const err = `<Error><Code>NoSuchUpload</Code><UploadId>attacker</UploadId></Error>`;
		expect(readUploadId(err)).toBeNull();
	});

	test("null on malformed XML, a missing element, and an empty one", () => {
		expect(readUploadId("<InitiateMultipartUploadResult><UploadId>x")).toBeNull();
		expect(
			readUploadId("<InitiateMultipartUploadResult></InitiateMultipartUploadResult>"),
		).toBeNull();
		expect(
			readUploadId(
				"<InitiateMultipartUploadResult><UploadId>  </UploadId></InitiateMultipartUploadResult>",
			),
		).toBeNull();
		expect(readUploadId("")).toBeNull();
	});
});

describe("readListedParts", () => {
	function listing(inner: string) {
		return `<?xml version="1.0" encoding="UTF-8"?>
			<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${inner}</ListPartsResult>`;
	}

	test("reads every part and sorts by part number", () => {
		const parts = readListedParts(
			listing(`
				<Part><PartNumber>2</PartNumber><LastModified>2026-08-01T00:00:00Z</LastModified><ETag>&quot;bbb&quot;</ETag><Size>5</Size></Part>
				<Part><PartNumber>1</PartNumber><LastModified>2026-08-01T00:00:00Z</LastModified><ETag>&quot;aaa&quot;</ETag><Size>5</Size></Part>
			`),
		);
		expect(parts).toEqual([
			{ partNumber: 1, etag: '"aaa"' },
			{ partNumber: 2, etag: '"bbb"' },
		]);
	});

	test("handles ETag before PartNumber", () => {
		// The old regex required PartNumber first and returned NOTHING otherwise --
		// a listing in this order failed the whole completion with "no parts found".
		const parts = readListedParts(
			listing("<Part><ETag>&quot;aaa&quot;</ETag><PartNumber>1</PartNumber></Part>"),
		);
		expect(parts).toEqual([{ partNumber: 1, etag: '"aaa"' }]);
	});

	test("never pairs a part number with a neighbour's ETag", () => {
		// `.*?` under the `s` flag walked straight through `</Part>`, so a part
		// missing its ETag borrowed the next one's -- and the upload completed
		// against bytes that were not there.
		const parts = readListedParts(
			listing(`
				<Part><PartNumber>1</PartNumber></Part>
				<Part><PartNumber>2</PartNumber><ETag>&quot;bbb&quot;</ETag></Part>
			`),
		);
		expect(parts).toEqual([{ partNumber: 2, etag: '"bbb"' }]);
	});

	test("drops parts with an unusable part number", () => {
		const parts = readListedParts(
			listing(`
				<Part><PartNumber>0</PartNumber><ETag>&quot;a&quot;</ETag></Part>
				<Part><PartNumber>x</PartNumber><ETag>&quot;b&quot;</ETag></Part>
				<Part><PartNumber>1.5</PartNumber><ETag>&quot;c&quot;</ETag></Part>
				<Part><PartNumber>3</PartNumber><ETag>&quot;d&quot;</ETag></Part>
			`),
		);
		expect(parts).toEqual([{ partNumber: 3, etag: '"d"' }]);
	});

	test("empty on malformed XML and on the wrong document", () => {
		expect(readListedParts("<ListPartsResult><Part>")).toEqual([]);
		expect(readListedParts("<Error><Code>NoSuchUpload</Code></Error>")).toEqual([]);
		expect(readListedParts("")).toEqual([]);
	});

	test("attributes on <Part> do not hide it", () => {
		const parts = readListedParts(
			listing(`<Part xmlns:x="urn:x"><PartNumber>1</PartNumber><ETag>&quot;a&quot;</ETag></Part>`),
		);
		expect(parts).toHaveLength(1);
	});
});

describe("renderCompleteBody", () => {
	const parts: UploadPart[] = [
		{ partNumber: 1, etag: '"aaa"' },
		{ partNumber: 2, etag: '"bbb"' },
	];

	test("renders the document S3 expects", () => {
		expect(renderCompleteBody(parts)).toBe(
			"<CompleteMultipartUpload>" +
				'<Part><PartNumber>1</PartNumber><ETag>"aaa"</ETag></Part>' +
				'<Part><PartNumber>2</PartNumber><ETag>"bbb"</ETag></Part>' +
				"</CompleteMultipartUpload>",
		);
	});

	test("what we send parses back to what we read", () => {
		// The property that actually matters: decode on the way in, encode on the
		// way out, and the ETag S3 gets is the ETag S3 gave us.
		const listed = readListedParts(
			`<ListPartsResult>
				<Part><PartNumber>1</PartNumber><ETag>&quot;a&amp;b&quot;</ETag></Part>
			</ListPartsResult>`,
		);
		const sent = parseXml(renderCompleteBody(listed));
		expect(childText(children(sent, "Part")[0], "ETag")).toBe('"a&b"');
	});

	test("an ETag with XML-significant characters cannot break the document", () => {
		const body = renderCompleteBody([{ partNumber: 1, etag: '"</ETag><Part>evil"' }]);
		const sent = parseXml(body);
		expect(children(sent, "Part")).toHaveLength(1);
		expect(childText(children(sent, "Part")[0], "ETag")).toBe('"</ETag><Part>evil"');
	});
});
