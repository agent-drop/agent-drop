import { describe, expect, test } from "bun:test";
import { slugFor } from "../src/api/hook-config";
import {
	GENERATED_SLUG_SUFFIX_LENGTH,
	generatedSlug,
	generatedSlugBase,
	MAX_WEBHOOK_SLUG_LENGTH,
	slugSuffix,
} from "../src/lib/webhook-defs";

const SUFFIX = /^[0-9a-hjkmnp-tv-z]{26}$/;

describe("generated webhook slugs", () => {
	test("uses 26 unbiased-base32 characters for 130 random bits", () => {
		const suffix = slugSuffix();

		expect(suffix).toHaveLength(GENERATED_SLUG_SUFFIX_LENGTH);
		expect(suffix).toMatch(SUFFIX);
	});

	test("keeps the complete generated slug inside the path-segment limit", () => {
		const slug = generatedSlug("a".repeat(MAX_WEBHOOK_SLUG_LENGTH));

		expect(slug).toHaveLength(MAX_WEBHOOK_SLUG_LENGTH);
		expect(slug).toMatch(/^a{37}-[0-9a-hjkmnp-tv-z]{26}$/);
	});

	test("create keeps deliberate exact slugs but protects generated names", () => {
		expect(slugFor({ slug: "Public_Endpoint" })).toBe("public-endpoint");
		expect(slugFor({ name: "Stripe Prod" })).toMatch(/^stripe-prod-[0-9a-hjkmnp-tv-z]{26}$/);
	});

	test("rotation recovers the chosen base from legacy and current suffixes", () => {
		expect(generatedSlugBase("stripe-prod-k7f2q9")).toBe("stripe-prod");
		expect(generatedSlugBase("stripe-prod-k7f2q9m4v6x8z1a3b5c7d9e2fg")).toBe("stripe-prod");
	});
});
