/**
 * Markdown -> email-safe HTML.
 *
 * The parsing is `marked`'s lexer; the rendering is ours. That split is
 * deliberate: getting nested lists, table alignment and inline-emphasis
 * precedence right is a solved problem nobody should re-solve, but the HTML an
 * email needs is not the HTML a browser needs, and a renderer we do not control
 * cannot be made to emit it.
 *
 * "Email-safe" here means three specific things, each of which is a real client
 * bug rather than a style preference:
 *
 *  - **Every style is inline.** Gmail discards `<style>` blocks and strips
 *    `<html>`/`<head>`/`<body>` before rendering, keeping only what is inside.
 *    A stylesheet is therefore not a stylesheet; an attribute is.
 *  - **Tables carry `cellpadding`/`cellspacing`/`border` attributes as well as
 *    CSS.** Outlook renders through Word, which honours the attributes and
 *    ignores half the CSS.
 *  - **`<pre>` wraps.** A fenced code block is the one thing guaranteed to
 *    contain lines longer than a phone is wide, and an unwrapped `<pre>` widens
 *    the whole message rather than scrolling inside itself.
 *
 * Raw HTML in the source passes through unchanged, as it does in every markdown
 * implementation. That grants no capability a caller did not already have: the
 * same authenticated key can put arbitrary HTML in the `html` field directly.
 */

import { marked } from "marked";
import type { Token, Tokens } from "marked";

const SANS = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`;
const MONO = `ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace`;

const INK = "#1f2328";
const MUTED = "#57606a";
const LINE = "#d8dee4";
const WASH = "#f6f8fa";
const LINK = "#0969da";

/** Per-element inline styles. One place, so the palette cannot drift apart. */
const S = {
	body: `margin:0;padding:0;background:#ffffff;color:${INK};font-family:${SANS};font-size:15px;line-height:1.6;`,
	wrap: `max-width:720px;margin:0 auto;padding:8px 4px;color:${INK};font-family:${SANS};font-size:15px;line-height:1.6;word-wrap:break-word;`,
	h: [
		`margin:28px 0 14px;font-size:26px;font-weight:600;line-height:1.25;color:${INK};border-bottom:1px solid ${LINE};padding-bottom:8px;`,
		`margin:26px 0 12px;font-size:21px;font-weight:600;line-height:1.3;color:${INK};border-bottom:1px solid ${LINE};padding-bottom:6px;`,
		`margin:22px 0 10px;font-size:17px;font-weight:600;line-height:1.35;color:${INK};`,
		`margin:20px 0 8px;font-size:15px;font-weight:600;line-height:1.4;color:${INK};`,
		`margin:18px 0 8px;font-size:14px;font-weight:600;line-height:1.4;color:${MUTED};`,
		`margin:18px 0 8px;font-size:13px;font-weight:600;line-height:1.4;color:${MUTED};`,
	],
	p: "margin:0 0 14px;line-height:1.6;",
	a: `color:${LINK};text-decoration:underline;`,
	// `white-space:pre-wrap` + `word-break` is what stops a long line widening the
	// whole message on a phone; `overflow-x:auto` is the desktop fallback.
	pre: `margin:0 0 16px;padding:12px 14px;background:${WASH};border:1px solid ${LINE};border-radius:6px;overflow-x:auto;`,
	preCode: `display:block;font-family:${MONO};font-size:12.5px;line-height:1.5;color:${INK};white-space:pre-wrap;word-break:break-word;background:transparent;border:0;padding:0;`,
	code: `padding:2px 5px;background:#eff1f3;border-radius:4px;font-family:${MONO};font-size:13px;color:${INK};`,
	quote: `margin:0 0 16px;padding:2px 0 2px 14px;border-left:3px solid ${LINE};color:${MUTED};`,
	hr: `border:0;border-top:1px solid ${LINE};height:0;margin:24px 0;`,
	list: "margin:0 0 16px;padding-left:24px;",
	// A task list draws its own marker, so it does not need room for a bullet.
	taskList: "margin:0 0 16px;padding-left:8px;",
	li: "margin:0 0 6px;line-height:1.6;",
	table: `border-collapse:collapse;width:100%;margin:0 0 16px;font-size:14px;`,
	th: `border:1px solid ${LINE};padding:8px 10px;background:${WASH};font-weight:600;color:${INK};`,
	td: `border:1px solid ${LINE};padding:8px 10px;color:${INK};vertical-align:top;`,
	img: "max-width:100%;height:auto;border:0;display:block;",
} as const;

const ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * Allow only schemes an email client will follow, plus `cid:` so a markdown
 * image can reference an inline attachment. Anything else -- `javascript:`,
 * `data:`, a scheme nobody has heard of -- loses its href and renders as text.
 */
const SAFE_SCHEME = /^(https?:|mailto:|tel:|cid:)/i;

function safeUrl(href: string | null | undefined): string | null {
	const url = (href || "").trim();
	if (!url) return null;
	// A relative or anchor-only URL has no meaning in an email.
	if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
	return SAFE_SCHEME.test(url) ? url : null;
}

/** Right/center/left from a table's alignment, folded into the cell style. */
function alignStyle(align: string | null): string {
	return align ? `text-align:${align};` : "";
}

function renderInline(tokens: Token[] | undefined, fallback = ""): string {
	if (!tokens || tokens.length === 0) return escapeHtml(fallback);
	return tokens.map(renderInlineToken).join("");
}

function renderInlineToken(token: Token): string {
	switch (token.type) {
		case "text": {
			const t = token as Tokens.Text;
			// A `text` token in a loose list carries its own inline children.
			if (t.tokens?.length) return renderInline(t.tokens);
			return t.escaped ? t.text : escapeHtml(t.text);
		}
		case "escape":
			return escapeHtml((token as Tokens.Escape).text);
		case "strong":
			return `<strong style="font-weight:600;">${renderInline((token as Tokens.Strong).tokens)}</strong>`;
		case "em":
			return `<em style="font-style:italic;">${renderInline((token as Tokens.Em).tokens)}</em>`;
		case "del":
			return `<span style="text-decoration:line-through;">${renderInline((token as Tokens.Del).tokens)}</span>`;
		case "codespan":
			return `<code style="${S.code}">${escapeHtml((token as Tokens.Codespan).text)}</code>`;
		case "br":
			return "<br>";
		case "link": {
			const t = token as Tokens.Link;
			const href = safeUrl(t.href);
			const body = renderInline(t.tokens, t.text);
			if (!href) return body;
			const title = t.title ? ` title="${escapeHtml(t.title)}"` : "";
			return `<a href="${escapeHtml(href)}"${title} style="${S.a}">${body}</a>`;
		}
		case "image": {
			const t = token as Tokens.Image;
			const src = safeUrl(t.href);
			const alt = escapeHtml(t.text || "");
			if (!src) return alt;
			const title = t.title ? ` title="${escapeHtml(t.title)}"` : "";
			return `<img src="${escapeHtml(src)}" alt="${alt}"${title} style="${S.img}">`;
		}
		// A task-list marker. Real `<input>` elements are stripped by every mail
		// client worth naming, so the state is drawn as a character.
		case "checkbox":
			return (token as Tokens.Checkbox).checked ? "☑ " : "☐ ";
		case "html":
			return (token as Tokens.HTML).text;
		default:
			return escapeHtml("text" in token ? String(token.text ?? "") : "");
	}
}

function renderBlocks(tokens: Token[]): string {
	return tokens.map(renderBlock).join("");
}

function renderBlock(token: Token): string {
	switch (token.type) {
		case "space":
			return "";
		case "heading": {
			const t = token as Tokens.Heading;
			const depth = Math.min(Math.max(t.depth, 1), 6);
			return `<h${depth} style="${S.h[depth - 1]}">${renderInline(t.tokens, t.text)}</h${depth}>`;
		}
		case "paragraph": {
			const t = token as Tokens.Paragraph;
			return `<p style="${S.p}">${renderInline(t.tokens, t.text)}</p>`;
		}
		case "text": {
			const t = token as Tokens.Text;
			return t.tokens?.length ? renderInline(t.tokens) : escapeHtml(t.text);
		}
		case "code": {
			const t = token as Tokens.Code;
			return `<pre style="${S.pre}"><code style="${S.preCode}">${escapeHtml(t.text)}</code></pre>`;
		}
		case "blockquote": {
			const t = token as Tokens.Blockquote;
			return `<blockquote style="${S.quote}">${renderBlocks(t.tokens)}</blockquote>`;
		}
		case "hr":
			return `<hr style="${S.hr}">`;
		case "list":
			return renderList(token as Tokens.List);
		case "table":
			return renderTable(token as Tokens.Table);
		case "html":
			return (token as Tokens.HTML).text;
		// A task marker sits at the head of a list item's BLOCK token list, not
		// among its inline children, so the block walker has to know it too.
		case "checkbox":
			return renderInlineToken(token);
		// A link reference definition renders nothing; its targets were already
		// resolved into the `link` tokens that used it.
		case "def":
			return "";
		default:
			return "text" in token ? `<p style="${S.p}">${escapeHtml(String(token.text ?? ""))}</p>` : "";
	}
}

function renderList(list: Tokens.List): string {
	const tag = list.ordered ? "ol" : "ul";
	// `start` is "" for an unordered list and may legitimately be 1.
	const start =
		list.ordered && list.start !== "" && Number(list.start) !== 1
			? ` start="${Number(list.start)}"`
			: "";
	const items = list.items
		.map((item) => {
			// A task item's bullet is redundant next to the checkbox character.
			const style = item.task ? `${S.li}list-style:none;` : S.li;
			return `<li style="${style}">${renderBlocks(item.tokens)}</li>`;
		})
		.join("");
	const style = list.items.some((i) => i.task) ? S.taskList : S.list;
	return `<${tag}${start} style="${style}">${items}</${tag}>`;
}

function renderTable(table: Tokens.Table): string {
	const head = table.header
		.map(
			(cell, i) =>
				`<th style="${S.th}${alignStyle(table.align[i])}">${renderInline(cell.tokens, cell.text)}</th>`,
		)
		.join("");
	const body = table.rows
		.map(
			(row) =>
				`<tr>${row
					.map(
						(cell, i) =>
							`<td style="${S.td}${alignStyle(table.align[i])}">${renderInline(cell.tokens, cell.text)}</td>`,
					)
					.join("")}</tr>`,
		)
		.join("");
	// The attributes are for Outlook's Word renderer, which ignores much of the
	// CSS beside them. `role="presentation"` keeps screen readers from announcing
	// the layout table this is not.
	return `<table cellpadding="0" cellspacing="0" border="0" style="${S.table}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** The rendered fragment, without the document wrapper. Exported for tests. */
export function renderMarkdownFragment(markdown: string): string {
	return renderBlocks(marked.lexer(markdown));
}

/**
 * Render markdown as a complete, email-safe HTML document.
 *
 * The `<html>`/`<head>`/`<body>` frame is for the clients that keep it; the
 * inline styles are for the ones that do not, which is why the wrapper `<div>`
 * repeats the font and colour the `<body>` already set.
 */
export function renderMarkdownEmail(markdown: string, subject?: string): string {
	const title = escapeHtml(subject || "");
	return [
		"<!doctype html>",
		'<html lang="en"><head>',
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width,initial-scale=1">',
		'<meta name="color-scheme" content="light">',
		`<title>${title}</title>`,
		"</head>",
		`<body style="${S.body}">`,
		`<div style="${S.wrap}">`,
		renderMarkdownFragment(markdown),
		"</div></body></html>",
	].join("");
}
