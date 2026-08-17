import { beforeEach, describe, expect, test } from "bun:test";
import {
	buildRelayAddress,
	decodeEmail,
	encodeEmail,
	findRelayRule,
	isRelayReply,
	parseRelayAddress,
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

describe("buildRelayAddress / parseRelayAddress", () => {
	test("builds the documented shape", () => {
		expect(buildRelayAddress("lisa@mail.example", "j-7k9m", DOMAIN)).toBe(
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
			const addr = buildRelayAddress(sender, maskId, DOMAIN);
			const localPart = addr.slice(0, addr.lastIndexOf("@"));
			expect(parseRelayAddress(localPart)).toEqual({ sender, maskId });
		}
	});

	test("a sender containing + does not steal the mask boundary", () => {
		// parseRelayAddress splits on the LAST +. If it split on the first, the
		// mask would parse as "tag_at_example.com+j-7k9m" and the reply would go
		// nowhere -- or worse, to whatever rule happens to match that string.
		const addr = buildRelayAddress("user+tag@example.com", "j-7k9m", DOMAIN);
		const localPart = addr.slice(0, addr.lastIndexOf("@"));
		expect(parseRelayAddress(localPart)).toEqual({
			sender: "user+tag@example.com",
			maskId: "j-7k9m",
		});
	});

	test("returns null when there is no + at all", () => {
		expect(parseRelayAddress("lisa_at_mail.example")).toBeNull();
	});

	test("returns null when the part before + is not an encoded address", () => {
		// This is plain +addressing (lisa+sales@domain), NOT a relay reply.
		expect(parseRelayAddress("lisa+sales")).toBeNull();
	});
});

describe("isRelayReply", () => {
	test("true only when both markers are present", () => {
		expect(isRelayReply("lisa_at_mail.example+j-7k9m")).toBe(true);
		expect(isRelayReply("lisa+sales")).toBe(false);
		expect(isRelayReply("lisa_at_mail.example")).toBe(false);
		expect(isRelayReply("lisa")).toBe(false);
	});

	test("agrees with parseRelayAddress on addresses built by buildRelayAddress", () => {
		for (const sender of ["lisa@mail.example", "user+tag@example.com", "a@b.c"]) {
			const addr = buildRelayAddress(sender, "j-1", DOMAIN);
			const localPart = addr.slice(0, addr.lastIndexOf("@"));
			expect(isRelayReply(localPart)).toBe(true);
			expect(parseRelayAddress(localPart)).not.toBeNull();
		}
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
