/**
 * `rule-test`: what WOULD fire, without firing anything.
 *
 * Extracted from the command so the prediction is testable, because a dry run
 * that disagrees with the engine is worse than no dry run -- you check it
 * precisely when you are unsure, and it answers with confidence either way.
 *
 * The matching here mirrors `src/lib/rule-match.ts` on purpose: this runs
 * client-side against the rule list the API returns, so it can answer without a
 * server round trip per rule. The mirroring is what the tests pin.
 */

export interface PreviewRule {
	id?: string;
	pattern: string;
	type: string;
	scopes: string;
	target: string;
	enabled?: number | boolean;
	payload_mode?: string | null;
}

export type PreviewVerdict =
	| { fires: true; target: string; captures: Record<string, string> }
	| { fires: false; reason: string; captures: Record<string, string> };

export function matchPattern(
	pattern: string,
	name: string,
): { match: boolean; captures: Record<string, string> } {
	if (pattern === "*") return { match: true, captures: { name } };
	if (pattern === name) return { match: true, captures: {} };
	if (pattern.endsWith("-*")) {
		const prefix = pattern.slice(0, -2);
		if (name.startsWith(`${prefix}-`))
			return { match: true, captures: { name: name.slice(prefix.length + 1) } };
	}
	if (pattern.startsWith("*-")) {
		const suffix = pattern.slice(2);
		if (name.endsWith(`-${suffix}`))
			return { match: true, captures: { name: name.slice(0, -(suffix.length + 1)) } };
	}
	const starIdx = pattern.indexOf("*");
	if (starIdx > 0 && starIdx < pattern.length - 1) {
		const prefix = pattern.slice(0, starIdx);
		const suffix = pattern.slice(starIdx + 1);
		if (name.startsWith(prefix) && name.endsWith(suffix)) {
			const captured = name.slice(prefix.length, name.length - suffix.length);
			if (captured.length > 0) return { match: true, captures: { name: captured } };
		}
	}
	return { match: false, captures: {} };
}

export function substitute(tpl: string, vars: Record<string, string>): string {
	return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] || "");
}

/**
 * Would this one rule fire, and if not, why not.
 *
 * `null` means the pattern did not match at all -- not worth a line of output.
 * Everything else is worth saying out loud, including the near misses: "matches
 * but the scope excludes this channel" is the answer you came for at least as
 * often as "fires".
 */
export function previewRule(
	rule: PreviewRule,
	inbox: string,
	channel: string,
	vars: Record<string, string>,
): PreviewVerdict | null {
	const { match, captures } = matchPattern(rule.pattern, inbox);
	if (!match) return null;

	const scopes = rule.scopes.split(",").map((s) => s.trim());
	if (!scopes.includes(channel) && !scopes.includes("all")) {
		return { fires: false, reason: `scope "${rule.scopes}" excludes "${channel}"`, captures };
	}
	if (!rule.enabled) return { fires: false, reason: "DISABLED", captures };
	// The engine skips a forward on anything but email, because there is no
	// original message to re-send. Reporting it as firing here sends an operator
	// looking for a delivery that was never attempted.
	if (rule.type === "forward" && channel !== "email") {
		return { fires: false, reason: "forwards only fire on the email channel", captures };
	}

	return { fires: true, target: substitute(rule.target, { ...vars, ...captures }), captures };
}
