import { describe, expect, test } from "bun:test";
import { isAdmin } from "../src/lib/auth";
import { makeEnv, TEST_ADMIN_KEY } from "./helpers/env";

function req(authorization?: string): Request {
	return new Request("https://drop.test/api/keys", {
		headers: authorization ? { Authorization: authorization } : {},
	});
}

describe("isAdmin", () => {
	test("accepts the master credential", async () => {
		expect(await isAdmin(req(`Bearer ${TEST_ADMIN_KEY}`), makeEnv())).toBe(true);
	});

	test("rejects a wrong key, a missing header and a non-Bearer scheme", async () => {
		const env = makeEnv();
		expect(await isAdmin(req("Bearer wrong"), env)).toBe(false);
		expect(await isAdmin(req(), env)).toBe(false);
		expect(await isAdmin(req(`Basic ${TEST_ADMIN_KEY}`), env)).toBe(false);
	});

	test("rejects a strict prefix and a strict extension of the real key", async () => {
		const env = makeEnv();
		expect(await isAdmin(req(`Bearer ${TEST_ADMIN_KEY.slice(0, -1)}`), env)).toBe(false);
		expect(await isAdmin(req(`Bearer ${TEST_ADMIN_KEY}x`), env)).toBe(false);
	});

	test("case matters", async () => {
		expect(await isAdmin(req(`Bearer ${TEST_ADMIN_KEY.toUpperCase()}`), makeEnv())).toBe(false);
	});

	// REGRESSION: the check was `auth === \`Bearer ${env.ADMIN_API_KEY}\``. With
	// the secret unset that string is exactly "Bearer ", so the literal header
	// `Authorization: Bearer ` (or `Bearer undefined`) authenticated as admin
	// against every admin route -- a misconfigured or half-deployed worker was
	// wide open rather than closed.
	test("an unset ADMIN_API_KEY authenticates nothing", async () => {
		const empty = makeEnv({ ADMIN_API_KEY: "" });
		expect(await isAdmin(req("Bearer "), empty)).toBe(false);
		expect(await isAdmin(req("Bearer undefined"), empty)).toBe(false);
		expect(await isAdmin(req("Bearer null"), empty)).toBe(false);

		const missing = makeEnv({ ADMIN_API_KEY: undefined as unknown as string });
		expect(await isAdmin(req("Bearer "), missing)).toBe(false);
		expect(await isAdmin(req("Bearer undefined"), missing)).toBe(false);
	});

	// The compare must not be a raw string `===` on the secret: that bails at the
	// first differing byte, so its runtime leaks how long a prefix the attacker
	// got right. Digest-comparing makes the work independent of the guess, which
	// shows up here as `isAdmin` being async.
	test("is asynchronous, i.e. it hashes rather than string-compares", () => {
		const result = isAdmin(req("Bearer wrong"), makeEnv());
		expect(result).toBeInstanceOf(Promise);
	});
});
