import { AwsClient } from "aws4fetch";
import { generateId } from "../lib/id";
import { buildRawEmail, sendRawEmail, type MimeAttachment } from "../lib/relay";
import { slugifyFilename } from "../lib/normalize";
import { R2_BUCKET, R2_S3_ENDPOINT } from "../types";
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

// base64-encode raw bytes
function bufToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
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

// Resolve an attachment source (base64 / R2 / URL) into MIME-ready bytes
async function resolveAttachment(env: Env, a: AttachmentInput): Promise<MimeAttachment> {
	const inline = !!a.inline || !!a.cid;

	if (a.dataBase64) {
		return {
			filename: a.filename || "attachment",
			contentType: a.contentType || "application/octet-stream",
			contentBase64: a.dataBase64,
			inline,
			cid: a.cid,
		};
	}

	if (a.r2Key) {
		const obj = await env.BUCKET.get(a.r2Key);
		if (!obj) throw new Error(`attachment not found in R2: ${a.r2Key}`);
		const buf = await obj.arrayBuffer();
		return {
			filename: a.filename || obj.customMetadata?.originalFilename || basename(a.r2Key),
			contentType: a.contentType || obj.httpMetadata?.contentType || "application/octet-stream",
			contentBase64: bufToBase64(buf),
			inline,
			cid: a.cid,
		};
	}

	if (a.url) {
		const r = await fetch(a.url);
		if (!r.ok) throw new Error(`failed to fetch attachment url (${r.status}): ${a.url}`);
		const buf = await r.arrayBuffer();
		return {
			filename: a.filename || basename(a.url),
			contentType:
				a.contentType || r.headers.get("content-type")?.split(";")[0] || "application/octet-stream",
			contentBase64: bufToBase64(buf),
			inline,
			cid: a.cid,
		};
	}

	throw new Error("attachment must have one of: dataBase64, r2Key, url");
}

// POST /api/send/:inbox - send an email on behalf of a box (From: {inbox}@DOMAIN)
export async function handleSend(request: Request, env: Env, inbox: string): Promise<Response> {
	const body = (await request.json()) as {
		to?: string | string[];
		cc?: string | string[];
		bcc?: string | string[];
		replyTo?: string;
		fromName?: string;
		subject?: string;
		text?: string;
		html?: string;
		topic?: string;
		inReplyTo?: string;
		attachments?: AttachmentInput[];
		dryRun?: boolean;
		deleteAfterSend?: boolean;
	};

	const to = asList(body.to);
	const cc = asList(body.cc);
	const bcc = asList(body.bcc);

	if (to.length === 0 && cc.length === 0 && bcc.length === 0) {
		return Response.json(
			{ error: "at least one recipient (to/cc/bcc) is required" },
			{ status: 400 },
		);
	}
	if (!body.subject) {
		return Response.json({ error: "subject is required" }, { status: 400 });
	}
	if (!body.text && !body.html && !body.attachments?.length) {
		return Response.json({ error: "text, html, or attachments are required" }, { status: 400 });
	}

	// From address: optional +topic, optional display name
	const addr = `${inbox}${body.topic ? `+${body.topic}` : ""}@${env.DOMAIN}`;
	const from = body.fromName ? `"${body.fromName.replace(/"/g, "")}" <${addr}>` : addr;

	// Threading: resolve inReplyTo (a drop id -> its message-id, or a raw <message-id>)
	let inReplyTo: string | undefined;
	let references: string | undefined;
	if (body.inReplyTo) {
		if (body.inReplyTo.startsWith("<")) {
			inReplyTo = body.inReplyTo;
		} else {
			const row = await env.DB.prepare("SELECT metadata FROM drops WHERE id = ?")
				.bind(body.inReplyTo)
				.first<{ metadata: string | null }>();
			if (row?.metadata) {
				try {
					const m = JSON.parse(row.metadata);
					if (m.message_id) inReplyTo = m.message_id;
				} catch {
					/* ignore malformed metadata */
				}
			}
		}
		references = inReplyTo;
	}

	// Resolve attachment sources into bytes
	let attachments: MimeAttachment[];
	try {
		attachments = await Promise.all(
			(body.attachments || []).map((a) => resolveAttachment(env, a)),
		);
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : "attachment resolution failed" },
			{ status: 400 },
		);
	}

	const raw = buildRawEmail({
		from,
		to,
		cc,
		replyTo: body.replyTo,
		subject: body.subject,
		textBody: body.text,
		htmlBody: body.html,
		inReplyTo,
		references,
		attachments,
	});

	if (body.dryRun) {
		return Response.json({
			dryRun: true,
			from,
			to,
			cc,
			bcc,
			subject: body.subject,
			attachments: attachments.map((a) => ({
				filename: a.filename,
				contentType: a.contentType,
				inline: a.inline,
				cid: a.cid,
				bytes: Math.floor((a.contentBase64.length * 3) / 4),
			})),
			mimeBytes: raw.length,
			mime: raw,
		});
	}

	const messageId = await sendRawEmail(env, raw, { to, cc, bcc });

	// Opt-in cleanup: delete the outbound/temp R2 objects we just consumed
	if (body.deleteAfterSend) {
		const keys = (body.attachments || [])
			.map((a) => a.r2Key)
			.filter((k): k is string => !!k && k.startsWith("outbound/temp/"));
		await Promise.all(keys.map((k) => env.BUCKET.delete(k)));
	}

	// Log outbound
	const id = generateId();
	const recipients = [...to, ...cc, ...bcc].join(", ");
	await env.DB.prepare(
		`INSERT INTO outbound (id, inbox, to_addr, subject, body_text, ses_message_id, status, created_at)
		VALUES (?, ?, ?, ?, ?, ?, 'sent', ?)`,
	)
		.bind(id, inbox, recipients, body.subject, body.text || body.html || "", messageId, Date.now())
		.run();

	return Response.json({ sent: true, messageId, recipients: { to, cc, bcc } });
}

// POST /api/send/presign/:inbox - presigned PUT for an outbound attachment.
// Lands under outbound-tmp/ (no drop record). The send call later pulls it by r2_key.
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
	const url = new URL(`${R2_S3_ENDPOINT}/${R2_BUCKET}/${r2Key}`);
	url.searchParams.set("X-Amz-Expires", "3600");
	const signed = await aws.sign(
		new Request(url, { method: "PUT", headers: { "Content-Type": ct } }),
		{ aws: { signQuery: true } },
	);

	return Response.json({ uploadUrl: signed.url, r2Key, fileName: slugged });
}
