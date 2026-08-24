import { describe, expect, test } from "bun:test";
import { renderMarkdownEmail, renderMarkdownFragment } from "../src/lib/markdown";

/**
 * What is pinned here is the part an email client actually depends on, not the
 * exact byte sequence of the HTML: that every element carries an inline style
 * (because Gmail throws stylesheets away), that a table survives as a real
 * table with the attributes Outlook reads, that a code fence wraps instead of
 * widening the message, and that nothing hostile in the source becomes markup
 * in the output.
 */

describe("renderMarkdownFragment -- block elements", () => {
	test("headings render h1..h6 and each carries an inline style", () => {
		const html = renderMarkdownFragment("# one\n\n## two\n\n### three\n\n###### six");
		expect(html).toContain("<h1 style=");
		expect(html).toContain("<h2 style=");
		expect(html).toContain("<h3 style=");
		expect(html).toContain("<h6 style=");
		expect(html).toContain(">one</h1>");
		expect(html).toContain(">six</h6>");
	});

	test("paragraphs, emphasis and code spans", () => {
		const html = renderMarkdownFragment("a **b** and *c* and `d`");
		expect(html).toContain("<p style=");
		expect(html).toContain("<strong style=");
		expect(html).toContain("<em style=");
		expect(html).toContain("<code style=");
		expect(html).toContain(">d</code>");
	});

	test("a fenced code block wraps rather than widening the message", () => {
		const html = renderMarkdownFragment("```ts\nconst x: number = 1;\n```");
		expect(html).toContain("<pre style=");
		// The one property that stops a long line pushing the layout wide on a phone.
		expect(html).toContain("white-space:pre-wrap");
		expect(html).toContain("word-break:break-word");
		expect(html).toContain("const x: number = 1;");
	});

	test("code fence contents are escaped, not interpreted", () => {
		const html = renderMarkdownFragment("```html\n<script>alert(1)</script>\n```");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).not.toContain("<script>");
	});

	test("blockquotes, horizontal rules and nested lists", () => {
		const html = renderMarkdownFragment("> quoted\n\n---\n\n- one\n- two\n  - nested\n");
		expect(html).toContain("<blockquote style=");
		expect(html).toContain("<hr style=");
		// The nested <ul> lives inside its parent <li>.
		expect(html).toMatch(/<li style="[^"]*">[^<]*two[\s\S]*<ul[^>]*>[\s\S]*nested/);
	});

	test("an ordered list keeps a non-default start", () => {
		expect(renderMarkdownFragment("3. c\n4. d")).toContain('<ol start="3"');
		expect(renderMarkdownFragment("1. a\n2. b")).not.toContain("start=");
	});

	test("task list items render a character, never an <input>", () => {
		const html = renderMarkdownFragment("- [ ] todo\n- [x] done");
		expect(html).toContain("☐");
		expect(html).toContain("☑");
		expect(html).not.toContain("<input");
	});
});

describe("renderMarkdownFragment -- tables", () => {
	const html = renderMarkdownFragment("| a | b |\n|---|--:|\n| 1 | 2 |\n| 3 | 4 |");

	test("renders a real table with the attributes Outlook's renderer reads", () => {
		expect(html).toContain('cellpadding="0"');
		expect(html).toContain('cellspacing="0"');
		expect(html).toContain('border="0"');
		expect(html).toContain("border-collapse:collapse");
	});

	test("header cells are th, body cells are td, both styled inline", () => {
		expect(html).toContain("<th style=");
		expect(html).toContain("<td style=");
		expect((html.match(/<tr>/g) || []).length).toBe(3); // header + 2 rows
	});

	test("column alignment reaches both the header and the body cells", () => {
		// The second column is right-aligned; the first has no alignment at all.
		expect((html.match(/text-align:right/g) || []).length).toBe(3);
		expect(html).not.toContain("text-align:left");
	});
});

describe("renderMarkdownFragment -- links and images", () => {
	test("http, mailto and cid survive; cid is what makes an inline attachment work", () => {
		expect(renderMarkdownFragment("[x](https://frst.dev/)")).toContain(
			'<a href="https://frst.dev/"',
		);
		expect(renderMarkdownFragment("[x](mailto:a@b.com)")).toContain('href="mailto:a@b.com"');
		expect(renderMarkdownFragment("![logo](cid:logo)")).toContain('<img src="cid:logo"');
	});

	test("a javascript: or data: URL loses its href and renders as text", () => {
		const js = renderMarkdownFragment("[click](javascript:alert(1))");
		expect(js).not.toContain("javascript:");
		expect(js).not.toContain("<a ");
		expect(js).toContain("click");

		const data = renderMarkdownFragment("![x](data:text/html;base64,PHNjcmlwdD4=)");
		expect(data).not.toContain("<img");
		expect(data).toContain("x");
	});

	test("a relative URL is dropped -- it resolves against nothing in an inbox", () => {
		const html = renderMarkdownFragment("[docs](/spec/)");
		expect(html).not.toContain("<a ");
		expect(html).toContain("docs");
	});

	test("images are capped at the viewport width", () => {
		expect(renderMarkdownFragment("![a](https://x.dev/i.png)")).toContain("max-width:100%");
	});
});

describe("renderMarkdownFragment -- escaping", () => {
	test("angle brackets and quotes in prose become entities", () => {
		const html = renderMarkdownFragment('a < b & c > d "e"');
		expect(html).toContain("&lt;");
		expect(html).toContain("&amp;");
		expect(html).toContain("&gt;");
		expect(html).toContain("&quot;");
	});

	test("a link title is escaped inside the attribute", () => {
		const html = renderMarkdownFragment('[x](https://frst.dev/ "a \\" b")');
		expect(html).not.toMatch(/title="a " b"/);
		expect(html).toContain("&quot;");
	});

	test("raw HTML passes through, as markdown says it must", () => {
		// No capability is granted here: the same key can post `html` directly.
		expect(renderMarkdownFragment("<div>raw</div>")).toContain("<div>raw</div>");
	});
});

describe("renderMarkdownEmail -- the document wrapper", () => {
	test("wraps the fragment in a document whose styles are all inline", () => {
		const html = renderMarkdownEmail("# hi", "Subject line");
		expect(html.startsWith("<!doctype html>")).toBe(true);
		expect(html).toContain("<title>Subject line</title>");
		expect(html).toContain('name="viewport"');
		// Gmail strips <style> blocks, so there must not be one to rely on.
		expect(html).not.toContain("<style");
		expect(html).toContain("<h1 style=");
		expect(html.endsWith("</div></body></html>")).toBe(true);
	});

	test("the subject is escaped into the title", () => {
		expect(renderMarkdownEmail("x", '<script>"')).toContain("<title>&lt;script&gt;&quot;</title>");
	});

	test("empty markdown still produces a valid document", () => {
		const html = renderMarkdownEmail("");
		expect(html).toContain("<body");
		expect(html).toContain("</html>");
	});
});
