import { AwsClient } from "aws4fetch";
import type { Env, Drop } from "../types";
import { R2_BUCKET, R2_S3_ENDPOINT } from "../types";

export async function handleInbox(
	env: Env,
	inbox: string,
	subPath: string,
	url: URL,
): Promise<Response> {
	// GET /api/inbox/:name/latest
	if (subPath === "/latest") {
		const drop = await env.DB.prepare(
			"SELECT * FROM drops WHERE inbox = ? ORDER BY created_at DESC LIMIT 1",
		)
			.bind(inbox)
			.first<Drop>();

		if (!drop) {
			return Response.json({ error: "no drops" }, { status: 404 });
		}

		// Mark as read
		if (!drop.read_at) {
			await env.DB.prepare("UPDATE drops SET read_at = ? WHERE id = ?")
				.bind(Date.now(), drop.id)
				.run();
		}

		return Response.json(drop);
	}

	// GET /api/inbox/:name/:id/attachments
	const attMatch = subPath.match(/^\/([^/]+)\/attachments$/);
	if (attMatch) {
		const dropId = attMatch[1];
		const drop = await env.DB.prepare(
			"SELECT r2_prefix FROM drops WHERE id = ? AND inbox = ?",
		)
			.bind(dropId, inbox)
			.first<{ r2_prefix: string }>();

		if (!drop?.r2_prefix) {
			return Response.json({ error: "not found" }, { status: 404 });
		}

		// Check both attachments/ (email) and uploads/ (web/api)
		const [attList, uplList] = await Promise.all([
			env.BUCKET.list({ prefix: `${drop.r2_prefix}/attachments/` }),
			env.BUCKET.list({ prefix: `${drop.r2_prefix}/uploads/` }),
		]);
		const list = { objects: [...attList.objects, ...uplList.objects] };

		const files = list.objects.map((obj) => ({
			key: obj.key,
			filename: obj.key.split("/").pop(),
			size: obj.size,
			uploaded: obj.uploaded.toISOString(),
		}));

		return Response.json({ files });
	}

	// GET /api/inbox/:name/:id/file/:filename
	const fileMatch = subPath.match(/^\/([^/]+)\/file\/(.+)$/);
	if (fileMatch) {
		const [, dropId, rawFilename] = fileMatch;
		const filename = decodeURIComponent(rawFilename);
		const drop = await env.DB.prepare(
			"SELECT r2_prefix FROM drops WHERE id = ? AND inbox = ?",
		)
			.bind(dropId, inbox)
			.first<{ r2_prefix: string }>();

		if (!drop?.r2_prefix) {
			return Response.json({ error: "not found" }, { status: 404 });
		}

		// Try attachments/ first (email), then uploads/ (web/api)
		let obj = await env.BUCKET.get(`${drop.r2_prefix}/attachments/${filename}`);
		if (!obj) obj = await env.BUCKET.get(`${drop.r2_prefix}/uploads/${filename}`);
		if (!obj) {
			return Response.json({ error: "file not found" }, { status: 404 });
		}

		return new Response(obj.body, {
			headers: {
				"Content-Type":
					obj.httpMetadata?.contentType || "application/octet-stream",
				"Content-Disposition": `attachment; filename="${filename}"`,
			},
		});
	}

	// GET /api/inbox/:name/:id/url/:filename - presigned download URL
	const urlMatch = subPath.match(/^\/([^/]+)\/url\/(.+)$/);
	if (urlMatch) {
		const [, dropId, rawFilename] = urlMatch;
		const filename = decodeURIComponent(rawFilename);
		const ttl = parseInt(url.searchParams.get("ttl") || "3600");
		const drop = await env.DB.prepare(
			"SELECT r2_prefix FROM drops WHERE id = ? AND inbox = ?",
		)
			.bind(dropId, inbox)
			.first<{ r2_prefix: string }>();

		if (!drop?.r2_prefix) {
			return Response.json({ error: "not found" }, { status: 404 });
		}

		// Find the actual object key
		let objectKey = `${drop.r2_prefix}/attachments/${filename}`;
		let obj = await env.BUCKET.head(objectKey);
		if (!obj) {
			objectKey = `${drop.r2_prefix}/uploads/${filename}`;
			obj = await env.BUCKET.head(objectKey);
		}
		if (!obj) {
			return Response.json({ error: "file not found" }, { status: 404 });
		}

		const aws = new AwsClient({
			accessKeyId: env.R2_ACCESS_KEY_ID,
			secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		});

		const s3Url = new URL(`${R2_S3_ENDPOINT}/${R2_BUCKET}/${objectKey}`);
		s3Url.searchParams.set("X-Amz-Expires", String(Math.min(ttl, 86400)));

		const signed = await aws.sign(
			new Request(s3Url, { method: "GET" }),
			{ aws: { signQuery: true } },
		);

		return Response.json({
			url: signed.url,
			filename,
			size: obj.size,
			contentType: obj.httpMetadata?.contentType || "application/octet-stream",
			expires_in: `${Math.floor(ttl / 60)}m`,
		});
	}

	// GET /api/inbox/:name/:id (single drop)
	const idMatch = subPath.match(/^\/([^/]+)$/);
	if (idMatch) {
		const dropId = idMatch[1];
		const drop = await env.DB.prepare(
			"SELECT * FROM drops WHERE id = ? AND inbox = ?",
		)
			.bind(dropId, inbox)
			.first<Drop>();

		if (!drop) {
			return Response.json({ error: "not found" }, { status: 404 });
		}

		// Mark as read
		if (!drop.read_at) {
			await env.DB.prepare("UPDATE drops SET read_at = ? WHERE id = ?")
				.bind(Date.now(), drop.id)
				.run();
		}

		return Response.json(drop);
	}

	// GET /api/inbox/:name (list drops)
	const topic = url.searchParams.get("topic");
	const unread = url.searchParams.get("unread");
	const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 100);
	const since = url.searchParams.get("since");

	let query = "SELECT * FROM drops WHERE inbox = ? AND (status = 'completed' OR status IS NULL)";
	const params: (string | number)[] = [inbox];

	if (topic) {
		query += " AND topic = ?";
		params.push(topic);
	}
	if (unread === "true") {
		query += " AND read_at IS NULL";
	}
	if (since) {
		query += " AND created_at > ?";
		params.push(parseInt(since));
	}

	query += " ORDER BY created_at DESC LIMIT ?";
	params.push(limit);

	const { results } = await env.DB.prepare(query)
		.bind(...params)
		.all<Drop>();

	return Response.json({ inbox, count: results.length, drops: results });
}
