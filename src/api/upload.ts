import { AwsClient } from "aws4fetch";
import { parseJsonObject, readRequestCapped } from "../lib/body-limit";
import { type FinalizeDrop, resolveObjectKey } from "../lib/drops";
import { generateId } from "../lib/id";
import { slugifyFilename } from "../lib/normalize";
import { readListedParts, readUploadId, renderCompleteBody, type UploadPart } from "../lib/s3-xml";
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

const MiB = 1024 * 1024;

// Multipart init presigns every part up front, so the part COUNT is what bounds
// the signing work, and it stays fixed. The part SIZE grows with the file
// instead: 50 MiB until 100 of those no longer fit, then whatever whole number of
// MiB makes 100 parts cover it. R2 caps a part at 5 GiB, which caps the file at
// 100 x 5 GiB = 500 GiB (R2's own object ceiling, ~5 TiB, is never the limit).
export const MIN_MULTIPART_PART_BYTES = 50 * MiB;
export const MAX_MULTIPART_PART_BYTES = 5 * 1024 * MiB;
export const MAX_MULTIPART_PARTS = 100;
export const MAX_MULTIPART_BYTES = MAX_MULTIPART_PART_BYTES * MAX_MULTIPART_PARTS;

/**
 * The part size and count for a multipart upload of `fileSize` bytes, which must
 * be a positive safe integer no larger than MAX_MULTIPART_BYTES.
 *
 * R2 requires every part except the last to be the SAME size, so the client
 * must slice by exactly this `partSize` -- it is returned to it for that reason.
 */
export function planMultipart(fileSize: number): { partSize: number; partCount: number } {
	const spread = Math.ceil(Math.ceil(fileSize / MAX_MULTIPART_PARTS) / MiB) * MiB;
	const partSize = Math.max(MIN_MULTIPART_PART_BYTES, spread);
	return { partSize, partCount: Math.ceil(fileSize / partSize) };
}

// Every part URL is signed at init and the client uses the last ones last, so
// each has to outlive the whole upload: the file at a deliberately slow sustained
// link, never less than the hour every URL used to get, never more than the 7
// days SigV4 allows a presigned URL on S3 and R2 alike (R2's abort-multipart-7d
// lifecycle rule abandons the upload itself at that same age).
/** Bytes per second the part-URL lifetime assumes the client sustains. */
export const UPLOAD_THROUGHPUT_FLOOR = MiB;
export const MIN_PART_URL_TTL_SECONDS = 60 * 60;
export const MAX_PART_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

/** How long the part URLs of a `fileSize`-byte multipart upload stay valid, in seconds. */
export function partUrlTtlSeconds(fileSize: number): number {
	const atFloor = Math.ceil(fileSize / UPLOAD_THROUGHPUT_FLOOR);
	return Math.min(MAX_PART_URL_TTL_SECONDS, Math.max(MIN_PART_URL_TTL_SECONDS, atFloor));
}

/** `{fileName, contentType, fileSize, topic}`; only a filename can be long. */
export const MAX_UPLOAD_INIT_BODY_BYTES = 16 * 1024;

interface UploadInit {
	fileName: string;
	contentType: string;
	topic: string | null;
	/** Unchecked here: only multipart reads it, and validates it there. */
	fileSize: unknown;
}

/**
 * The body presign and multipart init share, bounded and type-checked. Both used
 * to call request.json() uncaught, unbounded, and hand `fileName` to
 * slugifyFilename unchecked -- so malformed JSON or a numeric fileName escaped
 * the handler as a 500.
 */
async function readUploadInit(request: Request): Promise<UploadInit | Response> {
	const bytes = await readRequestCapped(request, MAX_UPLOAD_INIT_BODY_BYTES, "request body");
	if (bytes instanceof Response) return bytes;
	const body = parseJsonObject(bytes);
	if (!body) {
		return Response.json({ error: "request body must be a JSON object" }, { status: 400 });
	}
	if (typeof body.fileName !== "string" || !body.fileName) {
		return Response.json({ error: "fileName required" }, { status: 400 });
	}
	for (const field of ["contentType", "topic"] as const) {
		const value = body[field];
		if (value !== undefined && value !== null && typeof value !== "string") {
			return Response.json({ error: `${field} must be a string` }, { status: 400 });
		}
	}
	return {
		fileName: body.fileName,
		contentType: (body.contentType as string | null | undefined) || "application/octet-stream",
		topic: (body.topic as string | null | undefined) || null,
		fileSize: body.fileSize,
	};
}

/** A fresh drop id and the R2 key its upload will be signed against. */
function newUploadKey(inbox: string, fileName: string) {
	const dropId = generateId();
	const r2Prefix = `drops/${inbox}/${dropId}`;
	const slugged = slugifyFilename(fileName);
	return { dropId, r2Prefix, slugged, objectKey: `${r2Prefix}/uploads/${slugged}` };
}

/** The `pending` row presign and multipart init both write before any byte lands. */
async function recordPendingDrop(
	request: Request,
	env: Env,
	ctx: DropContext | undefined,
	drop: ReturnType<typeof newUploadKey> & { inbox: string; init: UploadInit },
	extraMetadata: Record<string, unknown> = {},
): Promise<void> {
	const metadata = JSON.stringify({
		auth_method: ctx?.authMethod || "unknown",
		auth_key_name: ctx?.authKeyName || null,
		remote_ip: request.headers.get("CF-Connecting-IP") || null,
		user_agent: request.headers.get("User-Agent") || null,
		country: request.headers.get("CF-IPCountry") || null,
		...extraMetadata,
	});

	await env.DB.prepare(
		`INSERT INTO drops (id, inbox, topic, channel, subject,
			has_attachments, attachment_count, r2_prefix, object_key, metadata, status, created_at)
		VALUES (?, ?, ?, 'web', ?, 1, 1, ?, ?, ?, 'pending', ?)`,
	)
		.bind(
			drop.dropId,
			drop.inbox,
			drop.init.topic,
			drop.init.fileName,
			drop.r2Prefix,
			drop.objectKey,
			metadata,
			Date.now(),
		)
		.run();
}

// POST /api/upload/presign - get presigned PUT URL for direct upload
export async function handlePresign(
	request: Request,
	env: Env,
	inbox: string,
	ctx?: DropContext,
): Promise<Response> {
	const init = await readUploadInit(request);
	if (init instanceof Response) return init;

	const key = newUploadKey(inbox, init.fileName);

	const aws = s3Client(env);
	const url = new URL(s3Url(env, key.objectKey));
	url.searchParams.set("X-Amz-Expires", "3600");

	const signed = await aws.sign(
		new Request(url, {
			method: "PUT",
			headers: { "Content-Type": init.contentType },
		}),
		{ aws: { signQuery: true } },
	);

	await recordPendingDrop(request, env, ctx, { ...key, inbox, init });

	return Response.json({
		dropId: key.dropId,
		objectKey: key.objectKey,
		uploadUrl: signed.url,
		fileName: key.slugged,
		originalFileName: init.fileName,
	});
}

/**
 * What multipart init told the client to upload, recorded on the drop row as
 * `metadata.multipart_plan` so complete can check R2 against it. snake_case like
 * the rest of the metadata, which agents read back.
 */
interface MultipartPlan {
	file_size: number;
	part_size: number;
	part_count: number;
	/** When the part URLs stop working, ms since epoch. */
	expires_at: number;
}

// POST /api/upload/multipart - init multipart, return presigned URLs for all parts
export async function handleMultipartInit(
	request: Request,
	env: Env,
	inbox: string,
	ctx?: DropContext,
): Promise<Response> {
	const init = await readUploadInit(request);
	if (init instanceof Response) return init;
	const { fileSize } = init;

	if (fileSize === undefined) {
		return Response.json({ error: "fileSize required" }, { status: 400 });
	}
	if (typeof fileSize !== "number" || !Number.isSafeInteger(fileSize) || fileSize <= 0) {
		return Response.json({ error: "fileSize must be a positive safe integer" }, { status: 400 });
	}
	if (fileSize > MAX_MULTIPART_BYTES) {
		return Response.json(
			{ error: `fileSize exceeds multipart limit (${MAX_MULTIPART_BYTES} bytes)` },
			{ status: 413 },
		);
	}
	const { partSize, partCount: totalParts } = planMultipart(fileSize);

	const key = newUploadKey(inbox, init.fileName);
	const { objectKey } = key;
	const aws = s3Client(env);

	// Create multipart upload via S3 API
	const initUrl = new URL(s3Url(env, objectKey));
	initUrl.searchParams.set("uploads", "");

	const initRes = await aws.fetch(initUrl, {
		method: "POST",
		headers: { "Content-Type": init.contentType },
	});

	if (!initRes.ok) {
		const errText = await initRes.text();
		console.error("S3 CreateMultipartUpload failed:", errText);
		return Response.json({ error: "failed to init multipart" }, { status: 500 });
	}

	const uploadId = readUploadId(await initRes.text());
	if (!uploadId) {
		return Response.json({ error: "no upload ID" }, { status: 500 });
	}

	// Presign every part. Taken BEFORE signing, so the deadline reported is never
	// later than the one the signatures actually carry.
	const ttlSeconds = partUrlTtlSeconds(fileSize);
	const expiresAt = Date.now() + ttlSeconds * 1000;
	const parts: { partNumber: number; url: string }[] = [];

	for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
		const partUrl = new URL(s3Url(env, objectKey));
		partUrl.searchParams.set("partNumber", String(partNumber));
		partUrl.searchParams.set("uploadId", uploadId);
		partUrl.searchParams.set("X-Amz-Expires", String(ttlSeconds));

		const signed = await aws.sign(new Request(partUrl, { method: "PUT" }), {
			aws: { signQuery: true },
		});
		parts.push({ partNumber, url: signed.url });
	}

	const plan: MultipartPlan = {
		file_size: fileSize,
		part_size: partSize,
		part_count: totalParts,
		expires_at: expiresAt,
	};
	await recordPendingDrop(
		request,
		env,
		ctx,
		{ ...key, inbox, init },
		{
			multipart: true,
			multipart_plan: plan,
		},
	);

	return Response.json({
		dropId: key.dropId,
		uploadId,
		objectKey,
		partSize,
		parts,
		expiresAt,
	});
}

/**
 * The plan multipart init recorded on this row, or null for a row written before
 * plans were recorded -- those complete exactly as they always did. Only this
 * file writes the plan, so "unreadable" is treated as "absent" rather than as a
 * reason to strand an upload.
 */
function readMultipartPlan(metadata: string | null): MultipartPlan | null {
	if (!metadata) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(metadata);
	} catch {
		return null;
	}
	const plan = (parsed as { multipart_plan?: Partial<MultipartPlan> } | null)?.multipart_plan;
	if (!plan || typeof plan !== "object") return null;
	if (!Number.isSafeInteger(plan.file_size) || !Number.isSafeInteger(plan.part_count)) return null;
	return plan as MultipartPlan;
}

/**
 * How the parts R2 holds differ from the plan, or null when they are exactly
 * parts 1..N adding up to the planned file size. Every part must carry a size.
 */
function planMismatch(
	parts: (UploadPart & { size: number })[],
	plan: MultipartPlan,
): Record<string, unknown> | null {
	const listed = new Set(parts.map((p) => p.partNumber));
	const missingParts: number[] = [];
	for (let n = 1; n <= plan.part_count; n++) if (!listed.has(n)) missingParts.push(n);
	const receivedBytes = parts.reduce((sum, p) => sum + p.size, 0);

	if (
		missingParts.length === 0 &&
		parts.length === plan.part_count &&
		receivedBytes === plan.file_size
	) {
		return null;
	}
	return {
		expectedParts: plan.part_count,
		receivedParts: parts.length,
		missingParts,
		expectedBytes: plan.file_size,
		receivedBytes,
	};
}

// POST /api/upload/complete - finalize multipart upload.
// The router has already loaded `drop` and checked the caller may write to its
// inbox; `objectKey` is derived from that row, never from the request body.
export async function handleMultipartComplete(
	env: Env,
	drop: FinalizeDrop,
	body: { uploadId?: string },
): Promise<Response> {
	if (!body.uploadId) {
		return Response.json({ error: "uploadId required" }, { status: 400 });
	}

	const objectKey = resolveObjectKey(drop);
	if (!objectKey) {
		return Response.json({ error: "drop has no recorded upload key" }, { status: 409 });
	}

	const aws = s3Client(env);

	// List parts to get ETags (browser can't read them due to CORS)
	const listUrl = new URL(s3Url(env, objectKey));
	listUrl.searchParams.set("uploadId", body.uploadId);

	const listRes = await aws.fetch(listUrl, { method: "GET" });
	if (!listRes.ok) {
		return Response.json({ error: "failed to list parts" }, { status: 500 });
	}

	const parts = readListedParts(await listRes.text());

	// Completing with whatever R2 holds used to publish a truncated object as
	// `completed` when the client called this early. A row with a plan is checked
	// against it first. 409, not 400: the request is fine, the upload is not
	// finished, and the same request succeeds once the missing parts land --
	// nothing is aborted here, so the part URLs keep working until `expiresAt`.
	const plan = readMultipartPlan(drop.metadata);
	if (plan) {
		const sized = parts.filter((p): p is UploadPart & { size: number } => p.size !== undefined);
		if (sized.length !== parts.length) {
			console.error(`complete ${drop.id}: ListParts carried no part sizes; not completing`);
			return Response.json({ error: "could not verify the uploaded parts" }, { status: 500 });
		}
		const mismatch = planMismatch(sized, plan);
		if (mismatch) {
			return Response.json(
				{ error: "upload does not match its plan", ...mismatch },
				{ status: 409 },
			);
		}
	} else if (parts.length === 0) {
		return Response.json({ error: "no parts found" }, { status: 500 });
	}

	const completeXml = renderCompleteBody(parts);

	const completeUrl = new URL(s3Url(env, objectKey));
	completeUrl.searchParams.set("uploadId", body.uploadId);

	const completeRes = await aws.fetch(completeUrl, {
		method: "POST",
		headers: { "Content-Type": "application/xml" },
		body: completeXml,
	});

	if (!completeRes.ok) {
		return Response.json({ error: "failed to complete multipart" }, { status: 500 });
	}

	await env.DB.prepare("UPDATE drops SET status = 'completed' WHERE id = ?").bind(drop.id).run();

	return Response.json({ completed: true, dropId: drop.id });
}

// POST /api/upload/confirm - confirm a direct upload completed.
// Same contract as complete: the router has already authenticated the caller
// against `drop.inbox`.
//
// Since phase 5 this endpoint is no longer the only thing that completes a drop
// -- R2 event notifications do it too (src/lib/r2-events.ts), and whichever
// arrives first wins. So "already completed" is now the NORMAL outcome of a
// perfectly healthy upload, not an error. It used to 404 here, which would have
// turned the R2 consumer winning the race into a failed upload in the SPA.
export async function handleConfirm(env: Env, drop: FinalizeDrop): Promise<Response> {
	const done = (alreadyCompleted: boolean) =>
		Response.json({ confirmed: true, dropId: drop.id, alreadyCompleted });

	if (drop.status === "completed") return done(true);

	const result = await env.DB.prepare(
		"UPDATE drops SET status = 'completed' WHERE id = ? AND status = 'pending'",
	)
		.bind(drop.id)
		.run();

	if (result.meta.changes) return done(false);

	// The row was `pending` when the router read it and is not now: the R2
	// notification landed in between. Re-read rather than guess.
	const current = await env.DB.prepare("SELECT status FROM drops WHERE id = ?")
		.bind(drop.id)
		.first<{ status: string }>();
	if (current?.status === "completed") return done(true);

	return Response.json({ error: "drop is not in a confirmable state" }, { status: 409 });
}
