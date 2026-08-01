/**
 * A small, strict XML reader for the S3-compatible responses R2 sends back.
 *
 * There is no `DOMParser` in workerd, so the multipart-upload code used to
 * scrape its answers with regexes:
 *
 *   xml.match(/<UploadId>(.+?)<\/UploadId>/)
 *   xml.matchAll(/<Part>\s*<PartNumber>(\d+)<\/PartNumber>\s*.*?<ETag>(.+?)<\/ETag>\s*.*?<\/Part>/gs)
 *
 * Which is wrong in ways that are quiet rather than loud: the second pattern
 * needs `<PartNumber>` to come before `<ETag>` inside a `<Part>` (S3 does not
 * promise that), `.*?` with the `s` flag walks straight through `</Part>` so one
 * malformed part can pair a number with a neighbour's ETag, an element written
 * `<Part >` matches nothing, and the first pattern happily reads an `<UploadId>`
 * out of an `<Error>` body. None of that fails visibly -- it completes an upload
 * against the wrong bytes.
 *
 * This is not a general XML implementation. It handles elements, attributes,
 * text, CDATA, comments, processing instructions and the five predefined
 * entities plus numeric character references. It rejects anything malformed
 * instead of guessing. Namespaces are left as literal prefixes in the tag name,
 * which is all S3's flat documents need.
 */

export class XmlParseError extends Error {}

export interface XmlNode {
	/** Tag name, verbatim, prefix included. */
	name: string;
	attrs: Record<string, string>;
	children: XmlNode[];
	/** This element's own text content, entity-decoded. Descendants excluded. */
	text: string;
}

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[-A-Za-z0-9_:.]/;

function decodeEntities(input: string): string {
	if (!input.includes("&")) return input;
	return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
		if (body.startsWith("#x")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
		if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
		switch (body) {
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "amp":
				return "&";
			case "quot":
				return '"';
			case "apos":
				return "'";
			default:
				// An entity we do not know is left alone rather than silently dropped.
				return whole;
		}
	});
}

/** Escape text for XML element content. Only the characters that must be. */
export function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Parse a document and return its root element. Throws on malformed input. */
export function parseXml(input: string): XmlNode {
	let i = 0;
	const stack: XmlNode[] = [];
	let root: XmlNode | null = null;

	const fail = (why: string): never => {
		throw new XmlParseError(`${why} at offset ${i}`);
	};

	const skipTo = (marker: string) => {
		const at = input.indexOf(marker, i);
		if (at === -1) fail(`unterminated ${marker}`);
		i = at + marker.length;
	};

	const readName = (): string => {
		if (!NAME_START.test(input[i] ?? "")) fail("expected a tag name");
		const start = i;
		while (i < input.length && NAME_CHAR.test(input[i])) i++;
		return input.slice(start, i);
	};

	const skipSpace = () => {
		while (i < input.length && /\s/.test(input[i])) i++;
	};

	const readAttrs = (): Record<string, string> => {
		const attrs: Record<string, string> = {};
		for (;;) {
			skipSpace();
			if (i >= input.length) fail("unterminated tag");
			if (input[i] === ">" || input.startsWith("/>", i)) return attrs;
			const name = readName();
			skipSpace();
			if (input[i] !== "=") fail(`attribute ${name} has no value`);
			i++;
			skipSpace();
			const quote = input[i];
			if (quote !== '"' && quote !== "'") fail(`attribute ${name} is not quoted`);
			i++;
			const end = input.indexOf(quote, i);
			if (end === -1) fail(`unterminated value for attribute ${name}`);
			attrs[name] = decodeEntities(input.slice(i, end));
			i = end + 1;
		}
	};

	const open = (node: XmlNode) => {
		const parent = stack[stack.length - 1];
		if (parent) parent.children.push(node);
		else if (root) fail("a second root element");
		else root = node;
	};

	const addText = (text: string) => {
		const node = stack[stack.length - 1];
		if (node) node.text += text;
	};

	while (i < input.length) {
		if (input[i] !== "<") {
			const next = input.indexOf("<", i);
			const end = next === -1 ? input.length : next;
			addText(decodeEntities(input.slice(i, end)));
			i = end;
			continue;
		}

		if (input.startsWith("<!--", i)) {
			i += 4;
			skipTo("-->");
		} else if (input.startsWith("<![CDATA[", i)) {
			i += 9;
			const end = input.indexOf("]]>", i);
			if (end === -1) fail("unterminated CDATA");
			addText(input.slice(i, end));
			i = end + 3;
		} else if (input.startsWith("<?", i)) {
			i += 2;
			skipTo("?>");
		} else if (input.startsWith("<!", i)) {
			i += 2;
			skipTo(">");
		} else if (input.startsWith("</", i)) {
			i += 2;
			const name = readName();
			skipSpace();
			if (input[i] !== ">") fail("malformed closing tag");
			i++;
			const node = stack.pop();
			if (!node) fail(`closing tag </${name}> with nothing open`);
			if (node?.name !== name) fail(`</${name}> closes <${node?.name}>`);
		} else {
			i++;
			const node: XmlNode = { name: readName(), attrs: {}, children: [], text: "" };
			node.attrs = readAttrs();
			if (input.startsWith("/>", i)) {
				i += 2;
				open(node);
			} else if (input[i] === ">") {
				i++;
				open(node);
				stack.push(node);
			} else {
				fail("malformed tag");
			}
		}
	}

	if (stack.length) throw new XmlParseError(`unclosed <${stack[stack.length - 1].name}>`);
	if (!root) throw new XmlParseError("no root element");
	return root;
}

/** Direct children with this tag name, in document order. */
export function children(node: XmlNode, name: string): XmlNode[] {
	return node.children.filter((c) => c.name === name);
}

/** The text of the first direct child with this tag name. */
export function childText(node: XmlNode, name: string): string | undefined {
	return node.children.find((c) => c.name === name)?.text;
}
