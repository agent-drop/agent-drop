import { generateId } from "../lib/id";
import { parseJsonObject, readRequestCapped } from "../lib/body-limit";
import { slugifyFilename } from "../lib/normalize";
import { fireRules } from "../lib/rules";
import type { Env, Drop } from "../types";

export const MAX_DIRECT_MULTIPART_BYTES = 25 * 1024 * 1024;
export const MAX_DIRECT_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_DIRECT_UPLOAD_FILES = 32;
/** subject + text + html land in one D1 row, which D1 caps at 2 MB. */
export const MAX_DIRECT_JSON_BYTES = 1024 * 1024;

export interface DropContext {
	authMethod: "api_key" | "drop_token" | "email";
	authKeyName?: string;
	remoteIp?: string;
	userAgent?: string;
	country?: string;
	city?: string;
}

function extractContext(request: Request): Partial<DropContext> {
	return {
		remoteIp:
			request.headers.get("CF-Connecting-IP") || request.headers.get("X-Real-IP") || undefined,
		userAgent: request.headers.get("User-Agent") || undefined,
		country: request.headers.get("CF-IPCountry") || undefined,
		city: (request as any).cf?.city || undefined,
	};
}

export async function handleDrop(
	request: Request,
	env: Env,
	inbox: string,
	url: URL,
	dropCtx?: DropContext,
	execCtx?: ExecutionContext,
): Promise<Response> {
	const contentType = request.headers.get("Content-Type") || "";
	const topic = url.searchParams.get("topic") || null;
	const dropId = generateId();
	const r2Prefix = `drops/${inbox}/${dropId}`;

	// Build metadata JSON
	const reqCtx = extractContext(request);
	const metadata = JSON.stringify({
		auth_method: dropCtx?.authMethod || "unknown",
		auth_key_name: dropCtx?.authKeyName || null,
		remote_ip: reqCtx.remoteIp || null,
		user_agent: reqCtx.userAgent || null,
		country: reqCtx.country || null,
		city: reqCtx.city || null,
	});

	if (contentType.includes("multipart/form-data")) {
		const bytes = await readRequestCapped(
			request,
			MAX_DIRECT_MULTIPART_BYTES,
			"multipart request body",
		);
		if (bytes instanceof Response) return bytes;

		let formData: FormData;
		try {
			formData = await new Response(bytes, {
				headers: { "Content-Type": contentType },
			}).formData();
		} catch {
			return Response.json({ error: "invalid multipart form data" }, { status: 400 });
		}

		const subjectValue = formData.get("subject");
		const textValue = formData.get("text");
		const subject = typeof subjectValue === "string" ? subjectValue || null : null;
		const bodyText = typeof textValue === "string" ? textValue || null : null;
		const files = Array.from(formData.values()).filter(
			(value): value is File => typeof value !== "string",
		);
		if (files.length > MAX_DIRECT_UPLOAD_FILES) {
			return Response.json(
				{ error: `too many files (max ${MAX_DIRECT_UPLOAD_FILES})` },
				{ status: 413 },
			);
		}
		if (files.some((file) => file.size > MAX_DIRECT_UPLOAD_BYTES)) {
			return Response.json(
				{ error: `file exceeds direct-upload limit (${MAX_DIRECT_UPLOAD_BYTES} bytes)` },
				{ status: 413 },
			);
		}

		let attachmentCount = 0;
		const filenames: string[] = [];
		for (const file of files) {
			const slugged = slugifyFilename(file.name);
			await env.BUCKET.put(`${r2Prefix}/uploads/${slugged}`, file, {
				httpMetadata: { contentType: file.type },
				customMetadata: { originalFilename: file.name },
			});
			filenames.push(slugged);
			attachmentCount++;
		}

		await env.DB.prepare(
			`INSERT INTO drops (id, inbox, topic, channel, subject, body_text,
				has_attachments, attachment_count, r2_prefix, metadata, created_at)
			VALUES (?, ?, ?, 'web', ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				dropId,
				inbox,
				topic,
				subject,
				bodyText,
				attachmentCount > 0 ? 1 : 0,
				attachmentCount,
				r2Prefix,
				metadata,
				Date.now(),
			)
			.run();

		// Fire rules
		if (execCtx) {
			const drop: Drop = {
				id: dropId,
				inbox,
				topic,
				channel: "web",
				from_addr: null,
				from_user: null,
				subject,
				body_text: bodyText,
				body_html: null,
				has_attachments: attachmentCount > 0 ? 1 : 0,
				attachment_count: attachmentCount,
				r2_prefix: r2Prefix,
				raw_r2_key: null,
				metadata,
				created_at: Date.now(),
				read_at: null,
			};
			await fireRules(env, execCtx, drop, "web");
		}

		return Response.json(
			{ id: dropId, inbox, attachments: attachmentCount, files: filenames },
			{ status: 201 },
		);
	}

	// JSON body -- bounded like the multipart branch, and every field a string.
	const bytes = await readRequestCapped(request, MAX_DIRECT_JSON_BYTES, "JSON request body");
	if (bytes instanceof Response) return bytes;
	const parsed = parseJsonObject(bytes);
	if (!parsed) {
		return Response.json({ error: "request body must be a JSON object" }, { status: 400 });
	}
	for (const field of ["subject", "text", "html", "topic"] as const) {
		const value = parsed[field];
		if (value !== undefined && value !== null && typeof value !== "string") {
			return Response.json({ error: `${field} must be a string` }, { status: 400 });
		}
	}
	const body = parsed as { subject?: string; text?: string; html?: string; topic?: string };

	await env.DB.prepare(
		`INSERT INTO drops (id, inbox, topic, channel, subject, body_text, body_html,
			has_attachments, attachment_count, r2_prefix, metadata, created_at)
		VALUES (?, ?, ?, 'api', ?, ?, ?, 0, 0, ?, ?, ?)`,
	)
		.bind(
			dropId,
			inbox,
			body.topic || topic,
			body.subject || null,
			body.text || null,
			body.html || null,
			r2Prefix,
			metadata,
			Date.now(),
		)
		.run();

	// Fire rules
	if (execCtx) {
		const drop: Drop = {
			id: dropId,
			inbox,
			topic: body.topic || topic,
			channel: "api",
			from_addr: null,
			from_user: null,
			subject: body.subject || null,
			body_text: body.text || null,
			body_html: body.html || null,
			has_attachments: 0,
			attachment_count: 0,
			r2_prefix: r2Prefix,
			raw_r2_key: null,
			metadata,
			created_at: Date.now(),
			read_at: null,
		};
		await fireRules(env, execCtx, drop, "api");
	}

	return Response.json({ id: dropId, inbox }, { status: 201 });
}
