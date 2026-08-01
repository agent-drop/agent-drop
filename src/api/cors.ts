import type { Env } from "../types";

/**
 * The only routes a browser ever calls cross-origin. Everything else on /api is
 * CLI- and agent-driven over an Authorization header and needs no CORS headers
 * at all -- handing them out unconditionally is how
 * `Access-Control-Allow-Origin: *` ended up advertising the admin surface to
 * every page on the internet.
 */
function isBrowserRoute(path: string): boolean {
	return (
		path === "/api/health" ||
		path === "/api/config" ||
		path.startsWith("/api/drop/") ||
		path.startsWith("/api/upload/")
	);
}

export function corsHeadersFor(env: Env, path: string): Record<string, string> {
	if (!isBrowserRoute(path)) return {};
	return {
		// The real origin, not a wildcard: credentials travel on these routes.
		"Access-Control-Allow-Origin": `https://${env.DOMAIN}`,
		"Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Authorization, Content-Type",
	};
}
