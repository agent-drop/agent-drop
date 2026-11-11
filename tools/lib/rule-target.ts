/**
 * `drop rule-add` takes exactly one of --forward, --webhook or --relay, and that
 * choice is the rule's type. Two at once used to mean whichever the code checked
 * first; now it is an error, since either reading drops what the other asked for.
 *
 * The relay owner is passed through trimmed; the server is what insists it is
 * one bare address, so the CLI and the API cannot disagree about it.
 */
export type RuleTarget =
	| { type: "forward" | "webhook" | "relay"; target: string }
	| { error: string };

export function ruleTarget(opts: {
	forward: string[];
	webhook?: string;
	relay?: string;
}): RuleTarget {
	const forwards = opts.forward
		.flatMap((entry) => entry.split(","))
		.map((entry) => entry.trim())
		.filter(Boolean);
	const relay = opts.relay?.trim();
	const chosen = [forwards.length > 0, !!opts.webhook, !!relay].filter(Boolean).length;
	if (chosen === 0) {
		return { error: "Specify --forward <email> (repeatable), --webhook <url> or --relay <email>" };
	}
	if (chosen > 1) return { error: "Use only one of --forward, --webhook and --relay" };
	if (relay) return { type: "relay", target: relay };
	if (opts.webhook) return { type: "webhook", target: opts.webhook };
	return { type: "forward", target: forwards.join(",") };
}
