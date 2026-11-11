import { AwsClient } from "aws4fetch";
import {
	type ResolvedAttachment,
	toEmailAttachment,
	toRecipients,
	validateHeaderValue,
	validateHeaders,
	validateMessageId,
	validateRecipients,
} from "../lib/email-builder";
import { parseJsonObject, readBodyCapped, readRequestCapped } from "../lib/body-limit";
import { generateId } from "../lib/id";
import { renderMarkdownEmail } from "../lib/markdown";
import { renderBuilderPreview } from "../lib/mime";
import { slugifyFilename } from "../lib/normalize";
import { r2ObjectUrl } from "../types";
import type { Env } from "../types";

interface AttachmentInput {
	filename?: string;
	contentType?: string;
	dataBase64?: string; // small inline attachment
	r2Key?: string; // uploaded to outbound/temp/, pulled here
	url?: string; // remote, fetched here
	inline?: boolean;
	cid?: string;
}

/** Keep decoded attachments comfortably below the binding's 25 MiB message cap. */
export const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_ATTACHMENTS = 32;
/** Inline JSON is intentionally smaller; the CLI already moves files above 1 MB through R2. */
export const MAX_INLINE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Enough for one max-size inline attachment after base64 expansion, plus JSON metadata. */
export const MAX_EMAIL_REQUEST_BYTES = 8 * 1024 * 1024;
const REMOTE_ATTACHMENT_TIMEOUT_MS = 15_000;

class AttachmentResolutionError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

// Decode base64 into bytes. The Email Sending binding treats a string `content`
// as RAW content, so a base64 string would arrive as base64 text in the mail.
function base64ToBytes(encoded: string, maxBytes: number, limitMessage: string): ArrayBuffer {
	const compact = encoded.replace(/\s/g, "");
	const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
	const estimatedBytes = Math.floor((compact.length * 3) / 4) - padding;
	if (estimatedBytes > maxBytes) {
		throw new AttachmentResolutionError(limitMessage, 413);
	}

	let binary: string;
	try {
		binary = atob(compact);
	} catch {
		throw new AttachmentResolutionError("attachment dataBase64 is not valid base64");
	}
	if (binary.length > maxBytes) {
		throw new AttachmentResolutionError(limitMessage, 413);
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

function basename(p: string): string {
	const clean = p.split("?")[0].split("#")[0];
	const parts = clean.split("/");
	return parts[parts.length - 1] || "attachment";
}

function asList(v: string | string[] | undefined): string[] {
	if (!v) return [];
	return (Array.isArray(v) ? v : [v]).map((s) => String(s).trim()).filter(Boolean);
}

// Resolve an attachment source (base64 / R2 / URL) into bytes
function outboundTempPrefix(inbox: string): string {
	return `outbound/temp/${inbox}/`;
}

function isOwnedOutboundKey(inbox: string, key: string): boolean {
	return key.startsWith(outboundTempPrefix(inbox));
}

async function resolveAttachment(
	env: Env,
	inbox: string,
	a: AttachmentInput,
	remainingBytes: number,
): Promise<{ attachment: ResolvedAttachment; size: number }> {
	if (!a || typeof a !== "object") {
		throw new AttachmentResolutionError("each attachment must be an object");
	}
	for (const [label, value] of [
		["attachment filename", a.filename],
		["attachment contentType", a.contentType],
		["attachment cid", a.cid],
	] as const) {
		if (value === undefined) continue;
		if (typeof value !== "string") {
			throw new AttachmentResolutionError(`${label} must be a string`);
		}
		const error = validateHeaderValue(label, value);
		if (error) throw new AttachmentResolutionError(error);
	}
	const inline = !!a.inline || !!a.cid;
	const maxBytes = Math.min(MAX_ATTACHMENT_BYTES, remainingBytes);

	if (a.dataBase64 !== undefined && a.dataBase64 !== "") {
		if (typeof a.dataBase64 !== "string") {
			throw new AttachmentResolutionError("attachment dataBase64 must be a string");
		}
		const inlineMaxBytes = Math.min(maxBytes, MAX_INLINE_ATTACHMENT_BYTES);
		const content = base64ToBytes(
			a.dataBase64,
			inlineMaxBytes,
			maxBytes < MAX_INLINE_ATTACHMENT_BYTES
				? "attachments exceed the 16 MiB decoded-byte budget"
				: "inline attachment exceeds the 5 MiB decoded-byte limit",
		);
		return {
			attachment: {
				filename: a.filename || "attachment",
				contentType: a.contentType || "application/octet-stream",
				content,
				inline,
				cid: a.cid,
			},
			size: content.byteLength,
		};
	}

	if (a.r2Key !== undefined) {
		if (typeof a.r2Key !== "string") {
			throw new AttachmentResolutionError("attachment r2Key must be a string");
		}
		if (!isOwnedOutboundKey(inbox, a.r2Key)) {
			throw new AttachmentResolutionError("R2 attachment key is not owned by this inbox");
		}
		const obj = await env.BUCKET.get(a.r2Key);
		if (!obj) throw new AttachmentResolutionError(`attachment not found in R2: ${a.r2Key}`);
		if (obj.size > maxBytes) {
			throw new AttachmentResolutionError("attachments exceed the 16 MiB decoded-byte budget", 413);
		}
		const content = await obj.arrayBuffer();
		if (content.byteLength > maxBytes) {
			throw new AttachmentResolutionError("attachments exceed the 16 MiB decoded-byte budget", 413);
		}
		return {
			attachment: {
				filename: a.filename || obj.customMetadata?.originalFilename || basename(a.r2Key),
				contentType: a.contentType || obj.httpMetadata?.contentType || "application/octet-stream",
				content,
				inline,
				cid: a.cid,
			},
			size: content.byteLength,
		};
	}

	if (a.url !== undefined) {
		if (typeof a.url !== "string") {
			throw new AttachmentResolutionError("attachment url must be a string");
		}
		let url: URL;
		try {
			url = new URL(a.url);
		} catch {
			throw new AttachmentResolutionError("attachment url is invalid");
		}
		if (url.protocol !== "https:" && url.protocol !== "http:") {
			throw new AttachmentResolutionError("attachment url must use http or https");
		}

		let r: Response;
		try {
			r = await fetch(url, { signal: AbortSignal.timeout(REMOTE_ATTACHMENT_TIMEOUT_MS) });
		} catch {
			throw new AttachmentResolutionError(`failed to fetch attachment url: ${a.url}`);
		}
		if (!r.ok) {
			throw new AttachmentResolutionError(`failed to fetch attachment url (${r.status}): ${a.url}`);
		}
		const declaredHeader = r.headers.get("content-length");
		const declared = declaredHeader === null ? Number.NaN : Number(declaredHeader);
		if (Number.isFinite(declared) && declared > maxBytes) {
			await r.body?.cancel("attachment too large").catch(() => {});
			throw new AttachmentResolutionError("attachments exceed the 16 MiB decoded-byte budget", 413);
		}
		const bodyRead = await readBodyCapped(r.body, maxBytes);
		if (!bodyRead.ok) {
			throw new AttachmentResolutionError(
				bodyRead.reason === "too-large"
					? "attachments exceed the 16 MiB decoded-byte budget"
					: "could not read attachment url response",
				bodyRead.reason === "too-large" ? 413 : 400,
			);
		}
		return {
			attachment: {
				filename: a.filename || basename(a.url),
				contentType:
					a.contentType ||
					r.headers.get("content-type")?.split(";")[0] ||
					"application/octet-stream",
				content: bodyRead.bytes,
				inline,
				cid: a.cid,
			},
			size: bodyRead.bytes.byteLength,
		};
	}

	throw new AttachmentResolutionError("attachment must have one of: dataBase64, r2Key, url");
}

interface EmailBody {
	to?: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string;
	fromName?: string;
	subject?: string;
	text?: string;
	html?: string;
	/**
	 * Markdown source. Rendered server-side into the `html` part and, unless an
	 * explicit `text` is supplied, carried verbatim as the plain-text part --
	 * markdown being the one markup a plain-text reader can still read.
	 */
	markdown?: string;
	topic?: string;
	inReplyTo?: string;
	attachments?: AttachmentInput[];
	deleteAfterSend?: boolean;
}

async function readEmailBody(request: Request): Promise<EmailBody | Response> {
	const bytes = await readRequestCapped(request, MAX_EMAIL_REQUEST_BYTES, "email request body");
	if (bytes instanceof Response) return bytes;
	const parsed = parseJsonObject(bytes);
	if (!parsed) {
		return Response.json({ error: "email request body must be a JSON object" }, { status: 400 });
	}
	return parsed as EmailBody;
}

interface PreparedEmail {
	/** Exactly what goes to env.EMAIL.send(). */
	builder: EmailMessageBuilder;
	/** The recipient lists as supplied, for the outbound log. */
	to: string[];
	cc: string[];
	bcc: string[];
}

// Shared by /api/send and /api/compose: validate, resolve attachments, build the
// EmailMessageBuilder payload. Returns a 4xx Response on validation/resolution
// failure, else the prepared email.
async function prepareEmail(
	env: Env,
	inbox: string,
	body: EmailBody,
): Promise<PreparedEmail | Response> {
	const to = asList(body.to);
	const cc = asList(body.cc);
	const bcc = asList(body.bcc);

	const recipientError = validateRecipients(to, cc, bcc);
	if (recipientError) {
		return Response.json({ error: recipientError }, { status: 400 });
	}
	if (!body.subject) {
		return Response.json({ error: "subject is required" }, { status: 400 });
	}
	for (const [label, value] of [
		["subject", body.subject],
		["replyTo", body.replyTo],
		["fromName", body.fromName],
		["topic", body.topic],
		["inReplyTo", body.inReplyTo],
	] as const) {
		if (value === undefined || value === null) continue;
		if (typeof value !== "string") {
			return Response.json({ error: `${label} must be a string` }, { status: 400 });
		}
		const error = validateHeaderValue(label, value);
		if (error) return Response.json({ error }, { status: 400 });
	}
	if (!body.text && !body.html && !body.markdown && !body.attachments?.length) {
		return Response.json(
			{ error: "text, html, markdown, or attachments are required" },
			{ status: 400 },
		);
	}
	if (body.attachments !== undefined && !Array.isArray(body.attachments)) {
		return Response.json({ error: "attachments must be an array" }, { status: 400 });
	}
	if ((body.attachments?.length ?? 0) > MAX_ATTACHMENTS) {
		return Response.json(
			{ error: `too many attachments (max ${MAX_ATTACHMENTS})` },
			{ status: 413 },
		);
	}
	// Two sources for one MIME part. Silently preferring either one is the kind of
	// choice that is invisible until a caller wonders why half its message vanished.
	if (body.markdown && body.html) {
		return Response.json(
			{ error: "provide markdown or html, not both (markdown renders the html part)" },
			{ status: 400 },
		);
	}

	// Render before anything else touches the body, so `text` and `html` below are
	// simply "the parts", whichever field produced them.
	const text = body.text || body.markdown;
	const html = body.markdown ? renderMarkdownEmail(body.markdown, body.subject) : body.html;

	// From address: optional +topic, optional display name
	const addr = `${inbox}${body.topic ? `+${body.topic}` : ""}@${env.MAIL_DOMAIN}`;

	// Threading: resolve inReplyTo (a drop id -> its message-id, or a raw <message-id>)
	let inReplyTo: string | undefined;
	if (body.inReplyTo) {
		if (body.inReplyTo.startsWith("<")) {
			inReplyTo = body.inReplyTo;
		} else {
			const row = await env.DB.prepare("SELECT metadata FROM drops WHERE id = ? AND inbox = ?")
				.bind(body.inReplyTo, inbox)
				.first<{ metadata: string | null }>();
			if (row?.metadata) {
				try {
					const m = JSON.parse(row.metadata);
					if (typeof m.message_id === "string") inReplyTo = m.message_id;
				} catch {
					/* ignore malformed metadata */
				}
			}
		}
	}
	if (inReplyTo) {
		const messageIdError = validateMessageId(inReplyTo);
		if (messageIdError) return Response.json({ error: messageIdError }, { status: 400 });
	}

	// Resolve attachment sources into bytes
	const resolved: ResolvedAttachment[] = [];
	try {
		let totalBytes = 0;
		for (const input of body.attachments || []) {
			const { attachment, size } = await resolveAttachment(
				env,
				inbox,
				input,
				MAX_ATTACHMENT_TOTAL_BYTES - totalBytes,
			);
			resolved.push(attachment);
			totalBytes += size;
		}
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : "attachment resolution failed" },
			{ status: err instanceof AttachmentResolutionError ? err.status : 400 },
		);
	}

	// Only non-empty lists go in: `to: []` is not a recipient, and a cc-only or
	// bcc-only send is legal. validateRecipients above guarantees at least one of
	// the three survives, which is what the cast asserts.
	const destinations = {
		...(to.length ? { to: toRecipients(to) } : {}),
		...(cc.length ? { cc: toRecipients(cc) } : {}),
		...(bcc.length ? { bcc: toRecipients(bcc) } : {}),
	} as EmailDestinations;

	const builder: EmailMessageBuilder = {
		from: body.fromName ? { name: body.fromName.replace(/"/g, ""), email: addr } : addr,
		subject: body.subject,
		...destinations,
	};
	if (body.replyTo) builder.replyTo = body.replyTo;
	if (text) builder.text = text;
	if (html) builder.html = html;
	if (resolved.length) builder.attachments = resolved.map(toEmailAttachment);
	// Message-ID and Date are platform-controlled; only threading headers are ours.
	if (inReplyTo) builder.headers = { "In-Reply-To": inReplyTo, References: inReplyTo };

	const headerError = validateHeaders(builder.headers || {});
	if (headerError) {
		return Response.json({ error: headerError }, { status: 400 });
	}

	return { builder, to, cc, bcc };
}

// POST /api/compose/:inbox - build the email exactly as /api/send would, then
// render that same builder payload as raw RFC822 instead of sending it.
//
// The preview is rendered locally, so it approximates rather than reproduces
// what the platform puts on the wire (Message-ID, Date and the exact MIME
// nesting are the platform's). What it does guarantee is field parity with the
// send path: it is built from the builder, not from the request body.
export async function handleCompose(request: Request, env: Env, inbox: string): Promise<Response> {
	const body = await readEmailBody(request);
	if (body instanceof Response) return body;
	const prepared = await prepareEmail(env, inbox, body);
	if (prepared instanceof Response) return prepared;

	return new Response(renderBuilderPreview(prepared.builder), {
		headers: {
			"Content-Type": "message/rfc822; charset=utf-8",
			"Content-Disposition": 'inline; filename="composed.eml"',
		},
	});
}

// POST /api/send/:inbox - send an email on behalf of a box (From: {inbox}@MAIL_DOMAIN)
export async function handleSend(request: Request, env: Env, inbox: string): Promise<Response> {
	const body = await readEmailBody(request);
	if (body instanceof Response) return body;
	const prepared = await prepareEmail(env, inbox, body);
	if (prepared instanceof Response) return prepared;

	const { builder, to, cc, bcc } = prepared;
	// One send for the whole recipient list: the builder carries to/cc/bcc, so
	// Bcc stays off the visible headers without a message per recipient.
	const { messageId } = await env.EMAIL.send(builder);

	// Opt-in cleanup: delete the outbound/temp R2 objects we just consumed
	if (body.deleteAfterSend) {
		const keys = (body.attachments || [])
			.map((a) => a.r2Key)
			.filter((k): k is string => !!k && isOwnedOutboundKey(inbox, k));
		await Promise.all(keys.map((k) => env.BUCKET.delete(k)));
	}

	// Log outbound
	const id = generateId();
	const recipients = [...to, ...cc, ...bcc].join(", ");
	await env.DB.prepare(
		`INSERT INTO outbound (id, inbox, to_addr, subject, body_text, ses_message_id, status, created_at)
		VALUES (?, ?, ?, ?, ?, ?, 'sent', ?)`,
	)
		// From the builder, not the request body: a markdown send has neither a
		// `text` nor an `html` field, and logging "" for it would lose the message.
		.bind(
			id,
			inbox,
			recipients,
			body.subject,
			builder.text || builder.html || "",
			messageId,
			Date.now(),
		)
		.run();

	return Response.json({ sent: true, messageId, recipients: { to, cc, bcc } });
}

// POST /api/send/presign/:inbox - presigned PUT for an outbound attachment.
// Lands under outbound/temp/{inbox}/ (no drop record). The send call later pulls it by r2_key.
export async function handleSendPresign(
	request: Request,
	env: Env,
	inbox: string,
): Promise<Response> {
	const body = (await request.json()) as { fileName?: string; contentType?: string };
	if (!body.fileName) {
		return Response.json({ error: "fileName required" }, { status: 400 });
	}

	const slugged = slugifyFilename(body.fileName);
	const r2Key = `outbound/temp/${inbox}/${generateId()}/${slugged}`;
	const ct = body.contentType || "application/octet-stream";

	const aws = new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
	});
	const url = new URL(r2ObjectUrl(env, r2Key));
	url.searchParams.set("X-Amz-Expires", "3600");
	const signed = await aws.sign(
		new Request(url, { method: "PUT", headers: { "Content-Type": ct } }),
		{
			aws: { signQuery: true },
		},
	);

	return Response.json({ uploadUrl: signed.url, r2Key, fileName: slugged });
}
