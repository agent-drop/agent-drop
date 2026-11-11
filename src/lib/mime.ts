/**
 * Hand-rolled MIME assembly.
 *
 * Since outbound mail moved to `EmailMessageBuilder`, the platform assembles the
 * MIME for every message we compose or forward. Two callers still need bytes:
 *
 *  - the email relay, which builds a message at enqueue time and replays the
 *    stored raw string through the legacy `EmailMessage` API in the queue
 *    consumer -- that is exactly what the raw API is for;
 *  - `POST /api/compose` (the CLI's `send-email --dry-run`), which previews a
 *    message without sending it. That preview is rendered FROM the same builder
 *    payload the send path hands to the binding, so a field that goes missing on
 *    the way into the builder goes missing from the preview too.
 *
 * The preview is an approximation of the wire format, not a promise about it:
 * Message-ID and Date are platform-controlled on the builder path.
 */

import { bareContentId, isHeaderControl } from "./email-builder";

export interface MimeAttachment {
	filename: string;
	contentType: string;
	contentBase64: string; // already base64-encoded bytes
	inline?: boolean;
	cid?: string;
}

// base64-encode a UTF-8 string
function b64(s: string): string {
	return btoa(unescape(encodeURIComponent(s)));
}

// wrap a base64 blob to 76-char lines (RFC 2045)
function wrap76(s: string): string {
	return (s.match(/.{1,76}/g) || []).join("\r\n");
}

function isPrintableAscii(s: string): boolean {
	return /^[\x20-\x7E]*$/.test(s);
}

// 45 bytes is 60 base64 chars, plus "=?UTF-8?B?" and "?=" makes 72: under the
// 75-char ceiling RFC 2047 sec. 2 puts on a single encoded-word.
const ENCODED_WORD_BYTES = 45;
const utf8 = new TextEncoder();

// RFC 2047-encode a header value if it contains non-ASCII. Long text becomes
// several encoded-words on folded lines, split between characters and never
// inside one, because a decoder may decode each word on its own.
function encodeHeaderWord(s: string): string {
	if (isPrintableAscii(s)) return s;
	const words: string[] = [];
	let chunk = "";
	let bytes = 0;
	for (const ch of s) {
		const size = utf8.encode(ch).byteLength;
		if (chunk && bytes + size > ENCODED_WORD_BYTES) {
			words.push(chunk);
			chunk = "";
			bytes = 0;
		}
		chunk += ch;
		bytes += size;
	}
	if (chunk) words.push(chunk);
	return words.map((w) => `=?UTF-8?B?${b64(w)}?=`).join("\r\n ");
}

/**
 * Reduce an untrusted display name to text that cannot reshape the header it
 * lands in. Control characters (CR and LF included) become spaces, so nothing
 * can start a new header line. `"` and `\` go, so nothing can close or escape
 * the quoted-string. `<` and `>` go too: they are legal inside quotes, but
 * `bareAddr` and `addressOf` take the FIRST `<...>` in the value as the address,
 * so a name carrying one would move it.
 */
export function sanitizeDisplayName(name: string): string {
	return singleLineHeader(name.replace(/["\\<>]/g, ""));
}

/**
 * Untrusted text for a header value (a forwarded Subject, a display name):
 * every control character, CR and LF included, becomes a space and runs of
 * whitespace collapse, so the value stays on its own header line. postal-mime
 * decodes RFC 2047 words back into raw line breaks, so "already parsed" is not
 * "already safe".
 */
export function singleLineHeader(value: string): string {
	return Array.from(value, (ch) => (isHeaderControl(ch.charCodeAt(0)) ? " " : ch))
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Render `name <address>` for a raw header. An ASCII name rides in a
 * quoted-string; anything else becomes RFC 2047 encoded-words, which must not
 * sit inside quotes (RFC 2047 sec. 5). The name is sanitized here because this
 * is the function that writes it into the header.
 */
export function formatMailbox(name: string, address: string): string {
	const clean = sanitizeDisplayName(name);
	if (!clean) return address;
	return isPrintableAscii(clean)
		? `"${clean}" <${address}>`
		: `${encodeHeaderWord(clean)} <${address}>`;
}

interface MimeEntity {
	ct: string;
	headers?: string[];
	body: string;
}

function renderPart(e: MimeEntity): string {
	return [`Content-Type: ${e.ct}`, ...(e.headers || []), "", e.body].join("\r\n");
}

function leafText(mime: string, text: string): MimeEntity {
	return {
		ct: `${mime}; charset=UTF-8`,
		headers: ["Content-Transfer-Encoding: base64"],
		body: wrap76(b64(text)),
	};
}

function leafAttachment(a: MimeAttachment): MimeEntity {
	const name = a.filename.replace(/"/g, "");
	const disp = a.inline ? "inline" : "attachment";
	const headers = [
		"Content-Transfer-Encoding: base64",
		`Content-Disposition: ${disp}; filename="${name}"`,
	];
	if (a.cid) headers.push(`Content-ID: <${bareContentId(a.cid)}>`);
	return {
		ct: `${a.contentType}; name="${name}"`,
		headers,
		body: wrap76(a.contentBase64),
	};
}

function multipart(subtype: string, parts: MimeEntity[]): MimeEntity {
	const boundary = `----=_Part_${crypto.randomUUID()}`;
	const body = [...parts.flatMap((p) => [`--${boundary}`, renderPart(p)]), `--${boundary}--`].join(
		"\r\n",
	);
	return { ct: `multipart/${subtype}; boundary="${boundary}"`, body };
}

/** Strip a "Display Name <addr>" wrapper down to the bare address. */
export function bareAddr(s: string): string {
	const m = s.match(/<([^>]+)>/);
	return (m ? m[1] : s).trim();
}

// Build a raw MIME email.
// Nesting: multipart/mixed[ multipart/related[ multipart/alternative, inline... ], attachments... ]
export function buildRawEmail(opts: {
	from: string;
	to: string | string[];
	cc?: string | string[];
	replyTo?: string;
	subject: string;
	textBody?: string;
	htmlBody?: string;
	inReplyTo?: string;
	references?: string;
	attachments?: MimeAttachment[];
}): string {
	const toList = (Array.isArray(opts.to) ? opts.to : [opts.to]).filter(Boolean);
	const ccList = (Array.isArray(opts.cc) ? opts.cc : opts.cc ? [opts.cc] : []).filter(Boolean);
	// Message-ID domain tracks the SENDING domain, which is the address inside the
	// angle brackets -- a display name may itself contain an @ (forwards read
	// `"sender@example.com (via lisa@frst.dev)" <lisa@frst.dev>`), so matching the
	// first @ in the whole string picks the wrong domain.
	const fromDomain = (bareAddr(opts.from).match(/@([^\s>]+)/)?.[1] || "localhost").trim();
	const messageId = `<${crypto.randomUUID()}@${fromDomain}>`;
	const date = new Date().toUTCString();

	const headers = [
		`From: ${opts.from}`,
		`To: ${toList.join(", ")}`,
		ccList.length ? `Cc: ${ccList.join(", ")}` : null,
		opts.replyTo ? `Reply-To: ${opts.replyTo}` : null,
		`Subject: ${encodeHeaderWord(opts.subject)}`,
		`Date: ${date}`,
		`Message-ID: ${messageId}`,
		opts.inReplyTo ? `In-Reply-To: ${opts.inReplyTo}` : null,
		opts.references ? `References: ${opts.references}` : null,
		`MIME-Version: 1.0`,
	].filter(Boolean) as string[];

	// 1. body (alternative if both, else single)
	let body: MimeEntity;
	if (opts.textBody && opts.htmlBody) {
		body = multipart("alternative", [
			leafText("text/plain", opts.textBody),
			leafText("text/html", opts.htmlBody),
		]);
	} else if (opts.htmlBody) {
		body = leafText("text/html", opts.htmlBody);
	} else {
		body = leafText("text/plain", opts.textBody || "");
	}

	const atts = opts.attachments || [];
	const inlines = atts.filter((a) => a.inline);
	const regular = atts.filter((a) => !a.inline);

	// 2. related wrapper for inline (cid) images
	let related = body;
	if (inlines.length) {
		related = multipart("related", [body, ...inlines.map(leafAttachment)]);
	}

	// 3. mixed wrapper for regular attachments
	let root = related;
	if (regular.length) {
		root = multipart("mixed", [related, ...regular.map(leafAttachment)]);
	}

	return [...headers, `Content-Type: ${root.ct}`, ...(root.headers || []), "", root.body].join(
		"\r\n",
	);
}

/** base64-encode raw bytes (ArrayBuffer / typed array). Strings are UTF-8 encoded. */
export function bytesToBase64(data: ArrayBuffer | ArrayBufferView | string): string {
	if (typeof data === "string") return b64(data);
	const bytes =
		data instanceof ArrayBuffer
			? new Uint8Array(data)
			: new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/** Render an address the way it goes into a header. */
function headerAddress(addr: string | EmailAddress): string {
	return typeof addr === "string" ? addr : formatMailbox(addr.name, addr.email);
}

function headerAddressList(
	addr: string | EmailAddress | (string | EmailAddress)[] | undefined,
): string[] {
	if (!addr) return [];
	return (Array.isArray(addr) ? addr : [addr]).map(headerAddress);
}

/**
 * Render a builder payload as raw MIME, for `POST /api/compose`.
 *
 * Deliberately derived from the builder rather than from the request body: the
 * preview is only worth having if it goes stale the moment the send path's field
 * mapping does. Bcc is omitted, matching what the sent message's headers carry.
 */
export function renderBuilderPreview(builder: EmailMessageBuilder): string {
	const headers = builder.headers || {};
	return buildRawEmail({
		from: headerAddress(builder.from),
		to: headerAddressList(builder.to),
		cc: headerAddressList(builder.cc),
		replyTo: builder.replyTo ? headerAddress(builder.replyTo) : undefined,
		subject: builder.subject,
		textBody: builder.text,
		htmlBody: builder.html,
		inReplyTo: headers["In-Reply-To"],
		references: headers.References,
		attachments: (builder.attachments || []).map((a) => ({
			filename: a.filename,
			contentType: a.type,
			contentBase64: bytesToBase64(a.content),
			inline: a.disposition === "inline",
			cid: a.contentId,
		})),
	});
}
