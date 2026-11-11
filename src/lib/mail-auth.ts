export const CLOUDFLARE_AUTH_SERVICE = "mx.cloudflare.net" as const;

/**
 * One result clause, together with the identity it is about.
 *
 * A bare result word is not evidence. Cloudflare reports SPF for the HELO name
 * and for the MAIL FROM address as two separate `spf=` clauses, and a
 * `dkim=pass` for some unrelated signing domain says nothing about the From
 * domain. The properties are what say which identity was checked.
 */
export interface AuthResult {
	/** Lowercased result word: `pass`, `fail`, `none`, `softfail`, ... */
	result: string;
	/** The clause's `reason=` value, unquoted, when it carries one. */
	reason?: string;
	/**
	 * Every RFC 8601 `ptype.property=value` pair, keyed by the lowercased
	 * `ptype.property` exactly as the RFC spells it: `smtp.mailfrom`,
	 * `smtp.helo`, `header.d`, `header.s`, `header.from`, `policy.dmarc`.
	 * A value that is one quoted string is unquoted; anything else is verbatim.
	 */
	props: Record<string, string>;
}

export interface SenderAuthResults {
	authserv: typeof CLOUDFLARE_AUTH_SERVICE;
	/** Field order. Select by property (`smtp.mailfrom`), never by position. */
	spf: AuthResult[];
	dkim: AuthResult[];
	dmarc: AuthResult[];
}

const MAX_AUTH_RESULTS_LENGTH = 16_384;
const KEYWORD = "[a-z][a-z0-9_-]*";
const QUOTED = String.raw`"(?:[^"\\]|\\[\s\S])*"`;
// A quoted string, a quoted local-part followed by `@domain`, or one unquoted
// run. Either way it must end at whitespace or the end of the clause, so a
// quoted value glued to the next token is malformed rather than silently merged.
const VALUE = String.raw`(${QUOTED}(?:@[^\s"]+)?|[^\s"]+)(?:\s+|$)`;
const METHOD = new RegExp(`^(${KEYWORD})`, "i");
const RESULT = new RegExp(
	String.raw`^(?:spf|dkim|dmarc)\s*(?:\/\s*\d+)?\s*=\s*(${KEYWORD})(?:\s+|$)`,
	"i",
);
const PROPSPEC = new RegExp(String.raw`^(${KEYWORD})\s*\.\s*(${KEYWORD})\s*=\s*${VALUE}`, "i");
const REASONSPEC = new RegExp(String.raw`^reason\s*=\s*${VALUE}`, "i");

/**
 * Split RFC 8601 clauses without treating delimiters inside comments or quoted
 * strings as structure. A comment becomes one space, because it is CFWS and
 * separates tokens: dropping it outright would glue `pa(x)ss` into `pass`.
 * Quoted strings are preserved so a property value cannot manufacture a new
 * top-level result.
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
			current += " ";
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

/** One quoted string loses its quotes and escapes; a quoted local-part keeps them. */
function unquote(value: string): string {
	if (!value.startsWith('"') || !value.endsWith('"')) return value;
	return value.slice(1, -1).replace(/\\([\s\S])/g, "$1");
}

/**
 * Parse one spf/dkim/dmarc clause: `method[/version]=result`, then an optional
 * `reason=value` and any number of `ptype.property=value` pairs. Anything else
 * after the result, or a property or reason given twice, is malformed: a
 * repeated `header.d` has no single answer, so the clause has none either.
 */
function parseResult(clause: string): AuthResult | null {
	const head = clause.match(RESULT);
	if (!head) return null;

	const entry: AuthResult = { result: head[1].toLowerCase(), props: {} };
	let rest = clause.slice(head[0].length);

	while (rest) {
		const prop = rest.match(PROPSPEC);
		if (prop) {
			const key = `${prop[1]}.${prop[2]}`.toLowerCase();
			if (Object.hasOwn(entry.props, key)) return null;
			entry.props[key] = unquote(prop[3]);
			rest = rest.slice(prop[0].length);
			continue;
		}

		const reason = rest.match(REASONSPEC);
		if (!reason || entry.reason !== undefined) return null;
		entry.reason = unquote(reason[1]);
		rest = rest.slice(reason[0].length);
	}

	return entry;
}

/**
 * Cloudflare's verdict on a parsed message: the FIRST physical
 * Authentication-Results field, the one Email Routing prepends. Any later field
 * was written by the sender and proves nothing. `headers` is postal-mime's
 * `parsed.headers`, which keeps the order the fields arrived in.
 */
export function firstSenderAuth(
	headers: readonly { key: string; value: string }[],
): SenderAuthResults | null {
	return parseSenderAuth(headers.find((header) => header.key === "authentication-results")?.value);
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
		const method = part.match(METHOD)?.[1]?.toLowerCase();
		if (method !== "spf" && method !== "dkim" && method !== "dmarc") continue;

		const entry = parseResult(part);
		if (!entry) return null;
		results[method].push(entry);
	}

	return results;
}
