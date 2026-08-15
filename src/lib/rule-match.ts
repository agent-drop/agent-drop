/**
 * Which rules apply, and what a pattern captured.
 *
 * The rules engine decides where things GO, and a bug here misroutes silently --
 * no exception, no failed delivery, just a stranger's inbox. Matching is kept
 * apart from firing for exactly that reason: it is pure, so it is pinned by
 * tests that need no queue, no email binding and no clock.
 */

import type { Env, RuleChannel } from "../types";

export interface Rule {
	id: string;
	pattern: string;
	type: "forward" | "webhook";
	scopes: string;
	target: string;
	headers: string | null;
	enabled: number;
	priority: number;
	/** Null on any row written before migration 0010, which means `envelope`. */
	payload_mode: string | null;
}

export interface RuleMatch {
	rule: Rule;
	captures: Record<string, string>;
}

function matchPattern(
	pattern: string,
	inbox: string,
): { match: boolean; captures: Record<string, string> } {
	if (pattern === "*") {
		return { match: true, captures: { name: inbox } };
	}
	if (pattern === inbox) {
		return { match: true, captures: {} };
	}
	if (pattern.endsWith("-*")) {
		const prefix = pattern.slice(0, -2);
		if (inbox.startsWith(`${prefix}-`)) {
			return { match: true, captures: { name: inbox.slice(prefix.length + 1) } };
		}
	}
	if (pattern.startsWith("*-")) {
		const suffix = pattern.slice(2);
		if (inbox.endsWith(`-${suffix}`)) {
			return { match: true, captures: { name: inbox.slice(0, -(suffix.length + 1)) } };
		}
	}
	const starIdx = pattern.indexOf("*");
	if (starIdx > 0 && starIdx < pattern.length - 1) {
		const prefix = pattern.slice(0, starIdx);
		const suffix = pattern.slice(starIdx + 1);
		if (inbox.startsWith(prefix) && inbox.endsWith(suffix)) {
			const captured = inbox.slice(prefix.length, inbox.length - suffix.length);
			if (captured.length > 0) {
				return { match: true, captures: { name: captured } };
			}
		}
	}
	return { match: false, captures: {} };
}

export function substitute(template: string, vars: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] || "");
}

/**
 * Every enabled rule whose pattern matches this box and whose scopes include
 * this channel. ALL of them, not the first -- cascading is the documented
 * behaviour, and a first-match engine would silently drop the audit copy the
 * moment somebody added a more specific rule.
 *
 * `all` covers `hook` exactly as it covers the other three. A scope word that
 * means "all except the newest channel" would be a lie in the data, and the one
 * type that could surprise an existing operator -- `forward` -- never fires on
 * anything but email anyway.
 */
export async function findMatchingRules(
	env: Env,
	inbox: string,
	channel: RuleChannel,
): Promise<RuleMatch[]> {
	const { results } = await env.DB.prepare(
		"SELECT * FROM drop_rules WHERE enabled = 1 ORDER BY priority DESC, created_at ASC",
	).all<Rule>();

	const matches: RuleMatch[] = [];
	for (const rule of results) {
		const { match, captures } = matchPattern(rule.pattern, inbox);
		if (!match) continue;
		const scopes = rule.scopes.split(",").map((s) => s.trim());
		if (!scopes.includes(channel) && !scopes.includes("all")) continue;
		matches.push({ rule, captures });
	}
	return matches;
}
