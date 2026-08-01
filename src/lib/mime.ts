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

import { bareContentId } from "./email-builder";

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

// RFC 2047-encode a header value if it contains non-ASCII
function encodeHeaderWord(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: printable-ASCII range bound
	return /^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
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
	if (typeof addr === "string") return addr;
	return `"${addr.name.replace(/"/g, "")}" <${addr.email}>`;
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
