import { describe, expect, test } from "bun:test";
import { ruleTarget } from "../tools/lib/rule-target";

/** `drop rule-add`'s three mutually exclusive destinations, as one decision. */
describe("ruleTarget", () => {
	test("--relay makes a relay rule to that one owner", () => {
		expect(ruleTarget({ forward: [], relay: " owner@example.org " })).toEqual({
			type: "relay",
			target: "owner@example.org",
		});
	});

	test("--forward joins repeated and comma-separated addresses", () => {
		expect(ruleTarget({ forward: ["a@x.org, b@x.org", "c@x.org"] })).toEqual({
			type: "forward",
			target: "a@x.org,b@x.org,c@x.org",
		});
	});

	test("--webhook makes a webhook rule", () => {
		expect(ruleTarget({ forward: [], webhook: "https://x.org/in" })).toEqual({
			type: "webhook",
			target: "https://x.org/in",
		});
	});

	test("nothing given names all three flags", () => {
		const result = ruleTarget({ forward: [] });
		expect("error" in result && result.error).toContain("--relay");
	});

	test("two destinations at once are refused", () => {
		for (const opts of [
			{ forward: ["a@x.org"], relay: "o@x.org" },
			{ forward: ["a@x.org"], webhook: "https://x.org" },
			{ forward: [], relay: "o@x.org", webhook: "https://x.org" },
		]) {
			const result = ruleTarget(opts);
			expect("error" in result && result.error).toContain("only one");
		}
	});
});
