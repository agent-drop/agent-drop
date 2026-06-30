import { AwsClient } from "aws4fetch";
import { generateId } from "../lib/id";
import { slugifyFilename } from "../lib/normalize";
import type { Env } from "../types";
import { r2ObjectUrl } from "../types";
import type { DropContext } from "./drop";

function s3Client(env: Env) {
	return new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
	});
}

function s3Url(env: Env, objectKey: string) {
	return r2ObjectUrl(env, objectKey);
}

const DIRECT_LIMIT = 95 * 1024 * 1024; // 95MB
const CHUNK_SIZE = 50 * 1024 * 1024; // 50MB

// POST /api/upload/presign - get presigned PUT URL for direct upload
export async function handlePresign(
	request: Request,
	env: Env,
	inbox: string,
	ctx?: DropContext,
): Promise<Response> {
	const body = (await request.json()) as {
		fileName: string;
		contentType?: string;
		fileSize?: number;
		topic?: string;
	};

	if (!body.fileName) {
		return Response.json({ error: "fileName required" }, { status: 400 });
	}

	const slugged = slugifyFilename(body.fileName);
	const dropId = generateId();
	const r2Prefix = `drops/${inbox}/${dropId}`;
	const objectKey = `${r2Prefix}/uploads/${slugged}`;
	const ct = body.contentType || "application/octet-stream";

	const aws = s3Client(env);
	const url = new URL(s3Url(env, objectKey));
	url.searchParams.set("X-Amz-Expires", "3600");

	const signed = await aws.sign(
		new Request(url, {
			method: "PUT",
			headers: { "Content-Type": ct },
		}),
		{ aws: { signQuery: true } },
	);

	// Build metadata
	const metadata = JSON.stringify({
		auth_method: ctx?.authMethod || "unknown",
		auth_key_name: ctx?.authKeyName || null,
		remote_ip: request.headers.get("CF-Connecting-IP") || null,
		user_agent: request.headers.get("User-Agent") || null,
		country: request.headers.get("CF-IPCountry") || null,
	});

	// Pre-create the drop record (status: pending upload)
	await env.DB.prepare(
		`INSERT INTO drops (id, inbox, topic, channel, subject,
			has_attachments, attachment_count, r2_prefix, metadata, status, created_at)
		VALUES (?, ?, ?, 'web', ?, 1, 1, ?, ?, 'pending', ?)`,
	)
		.bind(
			dropId, inbox, body.topic || null,
			body.fileName, r2Prefix, metadata, Date.now(),
		)
		.run();

	return Response.json({
		dropId,
		objectKey,
		uploadUrl: signed.url,
		fileName: slugged,
		originalFileName: body.fileName,
	});
}

// POST /api/upload/multipart - init multipart, return presigned URLs for all parts
export async function handleMultipartInit(
	request: Request,
	env: Env,
	inbox: string,
	ctx?: DropContext,
): Promise<Response> {
	const body = (await request.json()) as {
		fileName: string;
		contentType?: string;
		fileSize: number;
		topic?: string;
	};

	if (!body.fileName || !body.fileSize) {
		return Response.json({ error: "fileName and fileSize required" }, { status: 400 });
	}

	const slugged = slugifyFilename(body.fileName);
	const dropId = generateId();
	const r2Prefix = `drops/${inbox}/${dropId}`;
	const objectKey = `${r2Prefix}/uploads/${slugged}`;
	const ct = body.contentType || "application/octet-stream";
	const aws = s3Client(env);

	// Create multipart upload via S3 API
	const initUrl = new URL(s3Url(env, objectKey));
	initUrl.searchParams.set("uploads", "");

	const initRes = await aws.fetch(initUrl, {
		method: "POST",
		headers: { "Content-Type": ct },
	});

	if (!initRes.ok) {
		const errText = await initRes.text();
		console.error("S3 CreateMultipartUpload failed:", errText);
		return Response.json({ error: "failed to init multipart" }, { status: 500 });
	}

	const xml = await initRes.text();
	const uploadIdMatch = xml.match(/<UploadId>(.+?)<\/UploadId>/);
	if (!uploadIdMatch) {
		return Response.json({ error: "no upload ID" }, { status: 500 });
	}
	const uploadId = uploadIdMatch[1];

	// Generate presigned URLs for each part
	const totalParts = Math.ceil(body.fileSize / CHUNK_SIZE);
	const parts: { partNumber: number; url: string }[] = [];

	for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
		const partUrl = new URL(s3Url(env, objectKey));
		partUrl.searchParams.set("partNumber", String(partNumber));
		partUrl.searchParams.set("uploadId", uploadId);
		partUrl.searchParams.set("X-Amz-Expires", "3600");

		const signed = await aws.sign(
			new Request(partUrl, { method: "PUT" }),
			{ aws: { signQuery: true } },
		);
		parts.push({ partNumber, url: signed.url });
	}

	// Build metadata
	const metadata = JSON.stringify({
		auth_method: ctx?.authMethod || "unknown",
		auth_key_name: ctx?.authKeyName || null,
		remote_ip: request.headers.get("CF-Connecting-IP") || null,
		user_agent: request.headers.get("User-Agent") || null,
		country: request.headers.get("CF-IPCountry") || null,
		multipart: true,
	});

	// Pre-create drop record
	await env.DB.prepare(
		`INSERT INTO drops (id, inbox, topic, channel, subject,
			has_attachments, attachment_count, r2_prefix, metadata, status, created_at)
		VALUES (?, ?, ?, 'web', ?, 1, 1, ?, ?, 'pending', ?)`,
	)
		.bind(
			dropId, inbox, body.topic || null,
			body.fileName, r2Prefix, metadata, Date.now(),
		)
		.run();

	return Response.json({ dropId, uploadId, objectKey, parts });
}

// POST /api/upload/complete - finalize multipart upload
export async function handleMultipartComplete(
	request: Request,
	env: Env,
): Promise<Response> {
	const body = (await request.json()) as {
		dropId: string;
		uploadId: string;
		objectKey: string;
	};

	if (!body.dropId || !body.uploadId || !body.objectKey) {
		return Response.json({ error: "dropId, uploadId, objectKey required" }, { status: 400 });
	}

	const aws = s3Client(env);

	// List parts to get ETags (browser can't read them due to CORS)
	const listUrl = new URL(s3Url(env, body.objectKey));
	listUrl.searchParams.set("uploadId", body.uploadId);

	const listRes = await aws.fetch(listUrl, { method: "GET" });
	if (!listRes.ok) {
		return Response.json({ error: "failed to list parts" }, { status: 500 });
	}

	const listXml = await listRes.text();
	const partMatches = [
		...listXml.matchAll(
			/<Part>\s*<PartNumber>(\d+)<\/PartNumber>\s*.*?<ETag>(.+?)<\/ETag>\s*.*?<\/Part>/gs,
		),
	];
	if (partMatches.length === 0) {
		return Response.json({ error: "no parts found" }, { status: 500 });
	}

	const parts = partMatches
		.map((m) => ({ partNumber: Number(m[1]), etag: m[2] }))
		.sort((a, b) => a.partNumber - b.partNumber);

	// Complete multipart via S3 API
	const completeXml = [
		"<CompleteMultipartUpload>",
		...parts.map(
			(p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`,
		),
		"</CompleteMultipartUpload>",
	].join("");

	const completeUrl = new URL(s3Url(env, body.objectKey));
	completeUrl.searchParams.set("uploadId", body.uploadId);

	const completeRes = await aws.fetch(completeUrl, {
		method: "POST",
		headers: { "Content-Type": "application/xml" },
		body: completeXml,
	});

	if (!completeRes.ok) {
		return Response.json({ error: "failed to complete multipart" }, { status: 500 });
	}

	await env.DB.prepare(
		"UPDATE drops SET status = 'completed' WHERE id = ?",
	).bind(body.dropId).run();

	return Response.json({ completed: true, dropId: body.dropId });
}

// POST /api/upload/confirm - confirm a direct upload completed
export async function handleConfirm(
	request: Request,
	env: Env,
): Promise<Response> {
	const body = (await request.json()) as { dropId: string };

	if (!body.dropId) {
		return Response.json({ error: "dropId required" }, { status: 400 });
	}

	const result = await env.DB.prepare(
		"UPDATE drops SET status = 'completed' WHERE id = ? AND status = 'pending'",
	)
		.bind(body.dropId)
		.run();

	if (!result.meta.changes) {
		return Response.json({ error: "drop not found or already confirmed" }, { status: 404 });
	}

	return Response.json({ confirmed: true, dropId: body.dropId });
}
