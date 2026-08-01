import type { Env } from "../types";
import { normalizeInbox } from "./normalize";

// Top-level reserved path prefix for public static hosting:
//   {domain}/f/{box}/{site}/...  ->  R2  sites/{box}/{site}/...
// Kept under the apex {domain}/* route (NOT a subdomain), so it can never
// collide with other subdomains of the zone. /f/* is added to run_worker_first
// so these requests reach the Worker instead of the SPA fallback.
export const HOST_PREFIX = "f";

/**
 * Normalize a site (subfolder) name: lowercase, kebab, a-z0-9 and hyphens.
 * Unlike inbox names, a leading digit is allowed (e.g. "2024-launch").
 * Returns null if invalid.
 */
export function normalizeSite(raw: string): string | null {
	let s = raw.toLowerCase().trim();
	s = s
		.replace(/[\s_]+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	if (s.length < 1 || s.length > 64) return null;
	return s;
}

/**
 * Sanitize the relative path of a file within a site. Drops "." / ".." / empty
 * segments to prevent traversal. Case and structure are preserved so that
 * links inside hosted HTML resolve exactly as authored.
 */
export function sanitizeSitePath(p: string): string {
	return p
		.split("/")
		.map((s) => s.trim())
		.filter((s) => s && s !== "." && s !== "..")
		.join("/");
}

// Minimal extension -> content-type fallback (used when R2 has no stored type).
const EXT_TYPES: Record<string, string> = {
	html: "text/html; charset=utf-8",
	htm: "text/html; charset=utf-8",
	css: "text/css; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	mjs: "text/javascript; charset=utf-8",
	json: "application/json",
	xml: "application/xml",
	txt: "text/plain; charset=utf-8",
	md: "text/markdown; charset=utf-8",
	csv: "text/csv",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	svg: "image/svg+xml",
	ico: "image/x-icon",
	woff: "font/woff",
	woff2: "font/woff2",
	ttf: "font/ttf",
	otf: "font/otf",
	wasm: "application/wasm",
	pdf: "application/pdf",
	zip: "application/zip",
	mp4: "video/mp4",
	webm: "video/webm",
	mp3: "audio/mpeg",
	webmanifest: "application/manifest+json",
	map: "application/json",
};

function typeFromKey(key: string): string {
	const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
	return EXT_TYPES[ext] || "application/octet-stream";
}

function notFound(msg = "Not found"): Response {
	return new Response(msg, { status: 404, headers: { "Content-Type": "text/plain" } });
}

/**
 * Public URL for a hosted site.
 */
export function siteUrl(env: Env, inbox: string, site: string): string {
	return `https://${env.DOMAIN}/${HOST_PREFIX}/${inbox}/${site}/`;
}

/**
 * Serve a hosting request. Called only for paths under /{HOST_PREFIX}/...
 * Path shape: /f/{box}/{site}/{relpath}. Always returns a Response.
 */
export async function serveHostedSite(request: Request, env: Env, url: URL): Promise<Response> {
	// Strip the leading "/f" prefix, keep the rest of the segments.
	const segs = url.pathname.split("/").filter(Boolean); // ["f", box, site, ...rest]
	// segs[0] === HOST_PREFIX (guaranteed by the caller).

	const inbox = segs[1] ? normalizeInbox(decodeURIComponent(segs[1])) : null;
	const site = segs[2] ? normalizeSite(decodeURIComponent(segs[2])) : null;

	// /f, /f/{box} (no site) -> nothing to serve, bounce to the app.
	if (!inbox || !site) {
		return Response.redirect(`https://${env.DOMAIN}/`, 302);
	}

	// Registry: enforce existence + expiry + optional private token.
	const row = await env.DB.prepare(
		"SELECT auth_token, expires_at FROM hosted_sites WHERE inbox = ? AND site = ?",
	)
		.bind(inbox, site)
		.first<{ auth_token: string | null; expires_at: number | null }>();

	if (!row) return notFound();
	if (row.expires_at && row.expires_at < Date.now()) {
		return new Response("Site expired", { status: 410, headers: { "Content-Type": "text/plain" } });
	}
	if (row.auth_token && url.searchParams.get("auth") !== row.auth_token) {
		return new Response("Unauthorized", { status: 401, headers: { "Content-Type": "text/plain" } });
	}

	const rest = segs
		.slice(3)
		.map((s) => decodeURIComponent(s))
		.filter((s) => s !== "." && s !== "..");
	const prefix = `sites/${inbox}/${site}`;

	let key: string;
	if (rest.length === 0) {
		// /f/{box}/{site} -> redirect to .../ so relative links resolve correctly.
		if (!url.pathname.endsWith("/")) {
			return Response.redirect(siteUrl(env, inbox, site), 301);
		}
		key = `${prefix}/index.html`;
	} else {
		key = `${prefix}/${rest.join("/")}`;
		if (url.pathname.endsWith("/")) key += "index.html";
	}

	let obj = await env.BUCKET.get(key);
	// Directory-style request without trailing slash: try its index.html.
	if (!obj && !key.includes(".")) {
		obj = await env.BUCKET.get(`${key}/index.html`);
	}
	if (!obj) return notFound();

	const headers = new Headers();
	obj.writeHttpMetadata(headers);
	if (!headers.has("Content-Type")) headers.set("Content-Type", typeFromKey(key));
	headers.set("etag", obj.httpEtag);
	headers.set("Cache-Control", "public, max-age=3600");
	headers.set("X-Content-Type-Options", "nosniff");

	if (request.method === "HEAD") return new Response(null, { headers });
	return new Response(obj.body, { headers });
}
