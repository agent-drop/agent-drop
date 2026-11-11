import { beforeEach, describe, expect, test } from "bun:test";
import { handleMasks } from "../src/api/masks";
import {
	buildLegacyRelayAddress,
	createRelayAddress,
	decodeEmail,
	encodeEmail,
	findRelayRule,
	isRelayReply,
	legacyRelayRepliesEnabled,
	parseLegacyRelayAddress,
	parseRelayToken,
	resolveRelayAddress,
} from "../src/lib/relay";
import { makeEnv, type TestEnv } from "./helpers/env";

// Relay addressing is the mask system's whole privacy guarantee: the outside
// sender must reach the real mailbox, and must never learn its address. Two
// distinct failures live here -- a decode bug breaks reply routing (visible),
// and a parse bug can route a reply to the wrong mask (silent). Round-trip
// properties are the honest way to pin both.

const DOMAIN = "drop.test";

describe("encodeEmail / decodeEmail", () => {
	test("round-trips ordinary addresses", () => {
		for (const email of [
			"lisa@mail.example",
			"first.last@sub.example.co.uk",
			"user+tag@example.com",
			"UPPER@Example.COM",
			"a@b.c",
		]) {
			expect(decodeEmail(encodeEmail(email))).toBe(email);
		}
	});

	test("encoding replaces the @ with _at_", () => {
		expect(encodeEmail("lisa@mail.example")).toBe("lisa_at_mail.example");
	});

	test("decode splits on the LAST _at_, so a literal _at_ in the local part survives", () => {
		// "weird_at_name@example.com" encodes to "weird_at_name_at_example.com".
		// Splitting on the first _at_ would decode it to "weird@name_at_example.com"
		// -- a different mailbox, delivered without error.
		const original = "weird_at_name@example.com";
		expect(encodeEmail(original)).toBe("weird_at_name_at_example.com");
		expect(decodeEmail(encodeEmail(original))).toBe(original);
	});

	test("decode leaves a string with no _at_ untouched", () => {
		expect(decodeEmail("not-an-encoded-address")).toBe("not-an-encoded-address");
	});
});

describe("legacy sender-bearing relay addresses", () => {
	test("builds the documented shape", () => {
		expect(buildLegacyRelayAddress("lisa@mail.example", "j-7k9m", DOMAIN)).toBe(
			"lisa_at_mail.example+j-7k9m@drop.test",
		);
	});

	test("round-trips sender and mask through the local part", () => {
		const cases: [string, string][] = [
			["lisa@mail.example", "j-7k9m"],
			["first.last@sub.example.co.uk", "j-dating"],
			["weird_at_name@example.com", "j-shop"],
		];

		for (const [sender, maskId] of cases) {
			const addr = buildLegacyRelayAddress(sender, maskId, DOMAIN);
			const localPart = addr.slice(0, addr.lastIndexOf("@"));
			expect(parseLegacyRelayAddress(localPart)).toEqual({ sender, maskId });
		}
	});

	test("a sender containing + does not steal the mask boundary", () => {
		// parseRelayAddress splits on the LAST +. If it split on the first, the
		// mask would parse as "tag_at_example.com+j-7k9m" and the reply would go
		// nowhere -- or worse, to whatever rule happens to match that string.
		const addr = buildLegacyRelayAddress("user+tag@example.com", "j-7k9m", DOMAIN);
		const localPart = addr.slice(0, addr.lastIndexOf("@"));
		expect(parseLegacyRelayAddress(localPart)).toEqual({
			sender: "user+tag@example.com",
			maskId: "j-7k9m",
		});
	});

	test("returns null when there is no + at all", () => {
		expect(parseLegacyRelayAddress("lisa_at_mail.example")).toBeNull();
	});

	test("returns null when the part before + is not an encoded address", () => {
		// This is plain +addressing (lisa+sales@domain), NOT a relay reply.
		expect(parseLegacyRelayAddress("lisa+sales")).toBeNull();
	});
});

describe("isRelayReply", () => {
	test("recognizes current opaque routes and old sender-bearing routes", () => {
		expect(isRelayReply("reply+0123456789abcdefghjkmnpqrs")).toBe(true);
		expect(isRelayReply("lisa_at_mail.example+j-7k9m")).toBe(true);
		expect(isRelayReply("lisa+sales")).toBe(false);
		expect(isRelayReply("lisa_at_mail.example")).toBe(false);
		expect(isRelayReply("lisa")).toBe(false);
	});

	test("agrees with the legacy parser for old addresses", () => {
		for (const sender of ["lisa@mail.example", "user+tag@example.com", "a@b.c"]) {
			const addr = buildLegacyRelayAddress(sender, "j-1", DOMAIN);
			const localPart = addr.slice(0, addr.lastIndexOf("@"));
			expect(isRelayReply(localPart)).toBe(true);
			expect(parseLegacyRelayAddress(localPart)).not.toBeNull();
		}
	});
});

describe("opaque relay reply routes", () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = makeEnv();
		await env.DB.prepare(
			"INSERT INTO email_masks (id, label, active, created_at) VALUES (?, ?, 1, ?)",
		)
			.bind("j-7k9m", "shopping", Date.now())
			.run();
	});

	test("stores only a token digest and resolves the original route", async () => {
		const address = await createRelayAddress(env, "lisa@example.com", "j-7k9m");
		const localPart = address.slice(0, address.lastIndexOf("@"));
		const token = parseRelayToken(localPart);

		expect(address).toMatch(/^reply\+[0-9a-hjkmnp-tv-z]{26}@drop\.test$/);
		expect(token).toHaveLength(26);
		expect(localPart.length).toBe(32);
		expect(await resolveRelayAddress(env, localPart)).toEqual({
			sender: "lisa@example.com",
			maskId: "j-7k9m",
		});

		const row = env.DB.raw
			.query("SELECT token_hash, mask_id, sender FROM relay_reply_routes")
			.get() as { token_hash: string; mask_id: string; sender: string };
		expect(row).toMatchObject({ mask_id: "j-7k9m", sender: "lisa@example.com" });
		expect(row.token_hash).toHaveLength(64);
		expect(row.token_hash).not.toContain(token as string);
	});

	test("stays within the RFC local-part limit for a maximum-length sender", async () => {
		const sender = `${"a".repeat(64)}@example.com`;
		const legacyLocal = buildLegacyRelayAddress(sender, "j-7k9m", DOMAIN).split("@")[0];
		const currentLocal = (await createRelayAddress(env, sender, "j-7k9m")).split("@")[0];

		expect(legacyLocal.length).toBeGreaterThan(64);
		expect(currentLocal.length).toBe(32);
	});

	test("creates independent 130-bit bearer routes", async () => {
		const first = await createRelayAddress(env, "lisa@example.com", "j-7k9m");
		const second = await createRelayAddress(env, "lisa@example.com", "j-7k9m");
		expect(first).not.toBe(second);
		expect(env.DB.raw.query("SELECT COUNT(*) AS count FROM relay_reply_routes").get()).toEqual({
			count: 2,
		});
	});

	test("does not expire old routes, but disabling the mask makes them inert", async () => {
		const address = await createRelayAddress(env, "lisa@example.com", "j-7k9m");
		const localPart = address.split("@")[0];
		env.DB.raw.query("UPDATE relay_reply_routes SET created_at = 0").run();

		expect(await resolveRelayAddress(env, localPart)).not.toBeNull();
		env.DB.raw.query("UPDATE email_masks SET active = 0 WHERE id = 'j-7k9m'").run();
		expect(await resolveRelayAddress(env, localPart)).toBeNull();
	});

	test("deleting a mask removes its now-useless routes", async () => {
		await createRelayAddress(env, "lisa@example.com", "j-7k9m");
		const url = new URL("https://drop.test/api/masks/j-7k9m");
		const res = await handleMasks(new Request(url, { method: "DELETE" }), env, url);

		expect(res.status).toBe(200);
		expect(env.DB.raw.query("SELECT COUNT(*) AS count FROM relay_reply_routes").get()).toEqual({
			count: 0,
		});
	});

	test("a guessed token does not resolve", async () => {
		expect(await resolveRelayAddress(env, "reply+00000000000000000000000000")).toBeNull();
	});

	test("legacy routes are disabled by default and bounded by an absolute cutoff", async () => {
		const legacy = "lisa_at_example.com+j-7k9m";
		expect(legacyRelayRepliesEnabled(env)).toBe(false);
		expect(await resolveRelayAddress(env, legacy)).toBeNull();

		env.RELAY_LEGACY_REPLY_UNTIL = "2999-01-01T00:00:00Z";
		expect(legacyRelayRepliesEnabled(env)).toBe(true);
		expect(await resolveRelayAddress(env, legacy)).toEqual({
			sender: "lisa@example.com",
			maskId: "j-7k9m",
		});

		env.RELAY_LEGACY_REPLY_UNTIL = "2000-01-01T00:00:00Z";
		expect(legacyRelayRepliesEnabled(env)).toBe(false);
		expect(await resolveRelayAddress(env, legacy)).toBeNull();
	});
});

describe("findRelayRule", () => {
	let env: TestEnv;
	let seq = 0;

	async function seedRelayRule(
		pattern: string,
		target: string,
		opts: { enabled?: number; priority?: number; type?: string } = {},
	) {
		await env.DB.prepare(
			`INSERT INTO drop_rules (id, pattern, type, scopes, target, enabled, priority, created_at)
			VALUES (?, ?, ?, 'email', ?, ?, ?, ?)`,
		)
			.bind(
				`relay-${++seq}`,
				pattern,
				opts.type ?? "relay",
				target,
				opts.enabled ?? 1,
				opts.priority ?? 0,
				seq,
			)
			.run();
	}

	beforeEach(() => {
		env = makeEnv();
		seq = 0;
	});

	test("an exact mask pattern resolves to its target", async () => {
		await seedRelayRule("j-shop", "jonas@example.org");
		expect(await findRelayRule(env, "j-shop")).toMatchObject({ target: "jonas@example.org" });
		expect(await findRelayRule(env, "j-other")).toBeNull();
	});

	test('a "j-*" prefix pattern matches every mask under that prefix', async () => {
		await seedRelayRule("j-*", "jonas@example.org");

		expect(await findRelayRule(env, "j-7k9m")).toMatchObject({ target: "jonas@example.org" });
		expect(await findRelayRule(env, "j-dating")).toMatchObject({ target: "jonas@example.org" });
		// The hyphen is required: a bare "j" is not under "j-*".
		expect(await findRelayRule(env, "j")).toBeNull();
		expect(await findRelayRule(env, "k-7k9m")).toBeNull();
	});

	test("higher priority wins over a lower-priority catch-all", async () => {
		await seedRelayRule("*", "catchall@example.org", { priority: 0 });
		await seedRelayRule("j-shop", "shop@example.org", { priority: 10 });

		expect(await findRelayRule(env, "j-shop")).toMatchObject({ target: "shop@example.org" });
		expect(await findRelayRule(env, "x-1")).toMatchObject({ target: "catchall@example.org" });
	});

	test("disabled relay rules are ignored", async () => {
		await seedRelayRule("j-*", "jonas@example.org", { enabled: 0 });
		expect(await findRelayRule(env, "j-7k9m")).toBeNull();
	});

	test("forward and webhook rules are not treated as relay rules", async () => {
		// A forward rule matching "j-*" must not silently relay mail to its target.
		await seedRelayRule("j-*", "somewhere@else.com", { type: "forward" });
		await seedRelayRule("j-*", "https://hook", { type: "webhook" });
		expect(await findRelayRule(env, "j-7k9m")).toBeNull();
	});
});
