/**
 * Path matchers for the route tables in `router.ts`.
 *
 * Deliberately not `URLPattern`, which the runtime does have. Two of the three
 * shapes this API actually uses are not expressible in it:
 *
 * - The admin routes match by `startsWith`, not by segment -- `/api/keysfoo`
 *   reaches the keys handler. That is a wart, but it shipped, and this phase's
 *   contract is behavior-identical dispatch.
 * - `/api/inbox/:inbox` needs the remainder of the path captured VERBATIM and
 *   possibly empty, so one route serves `/api/inbox/lisa`,
 *   `/api/inbox/lisa/latest` and `/api/inbox/lisa/{id}/file/{name}` alike.
 *
 * Expressing those in URLPattern means several patterns per route plus a
 * fallback, which is more code than the twenty lines below and reads worse.
 */

export type Params = Record<string, string>;

/** Returns the captured params, or null if this route does not match. */
export type Matcher = (path: string) => Params | null;

const NO_PARAMS: Params = {};

/** One exact path, nothing else. */
export function exact(pattern: string): Matcher {
	return (path) => (path === pattern ? NO_PARAMS : null);
}

/**
 * Any path starting with `pattern`, INCLUDING partial-segment matches. The
 * handler does its own sub-routing from there.
 */
export function prefix(pattern: string): Matcher {
	return (path) => (path.startsWith(pattern) ? NO_PARAMS : null);
}

/**
 * Segment-wise match with `:name` captures, e.g. `/api/host/sites/:inbox/:site`.
 * Segment count must match exactly and a capture never matches an empty segment.
 */
export function segments(pattern: string): Matcher {
	const parts = pattern.split("/");
	return (path) => {
		const got = path.split("/");
		if (got.length !== parts.length) return null;
		const params: Params = {};
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			if (part.startsWith(":")) {
				if (!got[i]) return null;
				params[part.slice(1)] = got[i];
			} else if (part !== got[i]) {
				return null;
			}
		}
		return params;
	};
}

/**
 * `segments()` plus a `rest` capture holding everything after the last pattern
 * segment, verbatim and possibly empty -- the equivalent of the old
 * `^/api/inbox/([^/]+)(.*)$`.
 */
export function segmentsThenRest(pattern: string): Matcher {
	const match = segments(pattern);
	const depth = pattern.split("/").length;
	return (path) => {
		const head = path.split("/").slice(0, depth).join("/");
		const params = match(head);
		if (!params) return null;
		return { ...params, rest: path.slice(head.length) };
	};
}
