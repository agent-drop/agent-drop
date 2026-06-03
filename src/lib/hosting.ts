import type { Env } from "../types";
import { normalizeInbox } from "./normalize";

// Reserved first-level labels that must NOT be treated as a hosting box.
const RESERVED_LABELS = new Set(["www", "agent", "mail", "mx", "api"]);

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
	html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
	css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
	mjs: "text/javascript; charset=utf-8", json: "application/json",
	xml: "application/xml", txt: "text/plain; charset=utf-8",
	md: "text/markdown; charset=utf-8", csv: "text/csv",
	png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
	webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon",
	woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
	wasm: "application/wasm", pdf: "application/pdf", zip: "application/zip",
	mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg",
	webmanifest: "application/manifest+json", map: "application/json",
};

function typeFromKey(key: string): string {
	const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
	return EXT_TYPES[ext] || "application/octet-stream";
}

function notFound(msg = "Not found"): Response {
	return new Response(msg, { status: 404, headers: { "Content-Type": "text/plain" } });
}

/**
 * Serve a hosted site request for {box}.{DOMAIN}/{site}/...
 * Returns null if `host` is not a hosting subdomain (caller falls through to
 * the app / API). Otherwise always returns a Response.
 */
export async function serveHostedSite(
	request: Request,
	env: Env,
	url: URL,
): Promise<Response | null> {
	const host = url.hostname.toLowerCase();
	const apex = env.DOMAIN.toLowerCase();

	if (host === apex || !host.endsWith(`.${apex}`)) return null;
	const label = host.slice(0, host.length - apex.length - 1);
	// Only single-label subdomains (no nested dots) and not reserved infra labels.
	if (!label || label.includes(".") || RESERVED_LABELS.has(label)) return null;

	const inbox = normalizeInbox(label);
	if (!inbox) return notFound();

	const segs = url.pathname.split("/").filter(Boolean);
	// Root of the subdomain has no site subfolder -> bounce to the app.
	if (segs.length === 0) {
		return Response.redirect(`https://${apex}/`, 302);
	}

	const site = normalizeSite(decodeURIComponent(segs[0]));
	if (!site) return notFound();

	// Look up the site registry: enforce existence + expiry + optional token.
	const row = await env.DB.prepare(
		"SELECT auth_token, expires_at FROM hosted_sites WHERE inbox = ? AND site = ?",
	).bind(inbox, site).first<{ auth_token: string | null; expires_at: number | null }>();

	if (!row) return notFound();
	if (row.expires_at && row.expires_at < Date.now()) {
		return new Response("Site expired", { status: 410, headers: { "Content-Type": "text/plain" } });
	}
	if (row.auth_token && url.searchParams.get("auth") !== row.auth_token) {
		return new Response("Unauthorized", { status: 401, headers: { "Content-Type": "text/plain" } });
	}

	const rest = segs.slice(1).map((s) => decodeURIComponent(s)).filter((s) => s !== "." && s !== "..");
	const prefix = `sites/${inbox}/${site}`;

	let key: string;
	if (rest.length === 0) {
		// /{site} -> redirect to /{site}/ so relative links resolve correctly.
		if (!url.pathname.endsWith("/")) {
			return Response.redirect(`https://${host}/${site}/`, 301);
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
