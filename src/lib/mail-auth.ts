export const CLOUDFLARE_AUTH_SERVICE = "mx.cloudflare.net" as const;

export interface SenderAuthResults {
	authserv: typeof CLOUDFLARE_AUTH_SERVICE;
	spf: string[];
	dkim: string[];
	dmarc: string[];
}

const MAX_AUTH_RESULTS_LENGTH = 16_384;
const RESULT = /^(spf|dkim|dmarc)\s*(?:\/\s*\d+)?\s*=\s*([a-z][a-z0-9_-]*)(?:\s|$)/i;

/**
 * Split RFC 8601 clauses without treating delimiters inside comments or quoted
 * strings as structure. Comments are discarded; quoted strings are preserved
 * so a property value cannot manufacture a new top-level result.
 */
function clauses(value: string): string[] | null {
	if (value.length > MAX_AUTH_RESULTS_LENGTH) return null;

	const out: string[] = [];
	let current = "";
	let commentDepth = 0;
	let quoted = false;
	let escaped = false;

	for (const char of value) {
		if (escaped) {
			if (commentDepth === 0) current += char;
			escaped = false;
			continue;
		}

		if (commentDepth > 0) {
			if (char === "\\") escaped = true;
			else if (char === "(") commentDepth++;
			else if (char === ")") commentDepth--;
			continue;
		}

		if (quoted) {
			current += char;
			if (char === "\\") escaped = true;
			else if (char === '"') quoted = false;
			continue;
		}

		if (char === "(") {
			commentDepth = 1;
		} else if (char === ")") {
			return null;
		} else if (char === '"') {
			quoted = true;
			current += char;
		} else if (char === ";") {
			out.push(current.trim());
			current = "";
		} else {
			current += char;
		}
	}

	if (escaped || commentDepth > 0 || quoted) return null;
	out.push(current.trim());
	return out;
}

/**
 * Parse one physical Authentication-Results field from Cloudflare.
 *
 * The caller must supply the first physical field, which Cloudflare prepends
 * inside its Email Routing trust boundary. A missing, malformed, oversized, or
 * differently sourced value returns null and never changes delivery behavior.
 */
export function parseSenderAuth(header: string | null | undefined): SenderAuthResults | null {
	if (!header) return null;

	const parts = clauses(header);
	if (!parts?.length) return null;

	const [authserv, version, ...unexpected] = parts[0].split(/\s+/);
	if (
		authserv !== CLOUDFLARE_AUTH_SERVICE ||
		(version !== undefined && !/^\d+$/.test(version)) ||
		unexpected.length > 0
	) {
		return null;
	}

	const results: SenderAuthResults = {
		authserv: CLOUDFLARE_AUTH_SERVICE,
		spf: [],
		dkim: [],
		dmarc: [],
	};

	for (const part of parts.slice(1)) {
		const method = part.match(/^([a-z][a-z0-9_-]*)/i)?.[1]?.toLowerCase();
		if (method !== "spf" && method !== "dkim" && method !== "dmarc") continue;

		const match = part.match(RESULT);
		if (!match) return null;
		results[method].push(match[2].toLowerCase());
	}

	return results;
}
