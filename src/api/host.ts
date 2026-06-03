import { AwsClient } from "aws4fetch";
import { generateId } from "../lib/id";
import { normalizeSite, sanitizeSitePath } from "../lib/hosting";
import type { Env } from "../types";
import { R2_BUCKET, R2_S3_ENDPOINT } from "../types";

function s3Client(env: Env) {
	return new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
	});
}

// POST /api/host/presign/:box  { site, path, contentType }
// Returns a presigned PUT URL for sites/{box}/{site}/{path}.
export async function handleHostPresign(
	request: Request,
	env: Env,
	inbox: string,
): Promise<Response> {
	const body = (await request.json()) as {
		site: string;
		path: string;
		contentType?: string;
	};

	const site = normalizeSite(body.site || "");
	if (!site) return Response.json({ error: "invalid site name" }, { status: 400 });

	const rel = sanitizeSitePath(body.path || "");
	if (!rel) return Response.json({ error: "invalid file path" }, { status: 400 });

	const objectKey = `sites/${inbox}/${site}/${rel}`;
	const ct = body.contentType || "application/octet-stream";

	const aws = s3Client(env);
	const url = new URL(`${R2_S3_ENDPOINT}/${R2_BUCKET}/${objectKey}`);
	url.searchParams.set("X-Amz-Expires", "3600");

	const signed = await aws.sign(
		new Request(url, { method: "PUT", headers: { "Content-Type": ct } }),
		{ aws: { signQuery: true } },
	);

	return Response.json({ site, path: rel, key: objectKey, uploadUrl: signed.url });
}

// POST /api/host/finalize/:box  { site, ttlHours?, authToken? }
// Records/updates the site in the registry; counts are derived from R2.
export async function handleHostFinalize(
	request: Request,
	env: Env,
	inbox: string,
): Promise<Response> {
	const body = (await request.json()) as {
		site: string;
		ttlHours?: number;
		authToken?: string | null;
	};

	const site = normalizeSite(body.site || "");
	if (!site) return Response.json({ error: "invalid site name" }, { status: 400 });

	const prefix = `sites/${inbox}/${site}/`;
	let fileCount = 0;
	let totalBytes = 0;
	let cursor: string | undefined;
	do {
		const listed = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
		for (const o of listed.objects) {
			fileCount++;
			totalBytes += o.size;
		}
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);

	if (fileCount === 0) {
		return Response.json({ error: "no files uploaded for this site" }, { status: 400 });
	}

	const now = Date.now();
	const expiresAt = body.ttlHours ? now + body.ttlHours * 3_600_000 : null;
	const authToken = body.authToken || null;

	const existing = await env.DB.prepare(
		"SELECT id FROM hosted_sites WHERE inbox = ? AND site = ?",
	).bind(inbox, site).first<{ id: string }>();

	if (existing) {
		await env.DB.prepare(
			`UPDATE hosted_sites SET file_count = ?, total_bytes = ?, auth_token = ?,
				expires_at = ?, updated_at = ? WHERE id = ?`,
		).bind(fileCount, totalBytes, authToken, expiresAt, now, existing.id).run();
	} else {
		await env.DB.prepare(
			`INSERT INTO hosted_sites (id, inbox, site, file_count, total_bytes,
				auth_token, created_at, updated_at, expires_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(generateId(), inbox, site, fileCount, totalBytes, authToken, now, now, expiresAt).run();
	}

	return Response.json({
		site,
		url: `https://${inbox}.${env.DOMAIN}/${site}/`,
		fileCount,
		totalBytes,
		expiresAt,
		private: !!authToken,
	});
}

// GET /api/host/sites/:box
export async function handleHostList(env: Env, inbox: string): Promise<Response> {
	const { results } = await env.DB.prepare(
		"SELECT inbox, site, file_count, total_bytes, auth_token, created_at, updated_at, expires_at FROM hosted_sites WHERE inbox = ? ORDER BY updated_at DESC",
	).bind(inbox).all();

	const sites = results.map((r: any) => ({
		inbox: r.inbox,
		site: r.site,
		url: `https://${r.inbox}.${env.DOMAIN}/${r.site}/`,
		file_count: r.file_count,
		total_bytes: r.total_bytes,
		private: !!r.auth_token,
		created_at: r.created_at,
		updated_at: r.updated_at,
		expires_at: r.expires_at,
	}));

	return Response.json({ count: sites.length, sites });
}

// DELETE /api/host/sites/:box/:site
export async function handleHostDelete(env: Env, inbox: string, rawSite: string): Promise<Response> {
	const site = normalizeSite(rawSite);
	if (!site) return Response.json({ error: "invalid site name" }, { status: 400 });

	const prefix = `sites/${inbox}/${site}/`;
	let deleted = 0;
	let cursor: string | undefined;
	do {
		const listed = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
		const keys = listed.objects.map((o) => o.key);
		if (keys.length) {
			await env.BUCKET.delete(keys);
			deleted += keys.length;
		}
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);

	await env.DB.prepare("DELETE FROM hosted_sites WHERE inbox = ? AND site = ?")
		.bind(inbox, site).run();

	return Response.json({ deleted, site });
}
