import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleAPI } from "../src/api/router";
import {
	clearGoogleKeyCache,
	MAX_GOOGLE_TOKEN_LENGTH,
	validateGoogleToken,
} from "../src/lib/google-auth";
import { makeCtx, makeEnv } from "./helpers/env";

const realFetch = globalThis.fetch;
const invalid = { valid: false, email: null, name: null };

function encode(value: unknown): string {
	return btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function tokenFor(kid: string): string {
	return `${encode({ alg: "RS256", kid })}.${encode({})}.AA`;
}

beforeEach(() => {
	clearGoogleKeyCache();
});

afterEach(() => {
	globalThis.fetch = realFetch;
	clearGoogleKeyCache();
});

describe("Google token failure boundaries", () => {
	test("malformed base64 and JSON return the normal invalid result", async () => {
		const env = makeEnv();

		for (const token of ["not-a-jwt", "!.!.!", `${btoa("{")}.${encode({})}.AA`]) {
			expect(await validateGoogleToken(env, token)).toEqual(invalid);
		}
	});

	test("rejects an oversized token before any JWKS request", async () => {
		let fetched = false;
		globalThis.fetch = (async () => {
			fetched = true;
			return Response.json({ keys: [] });
		}) as unknown as typeof fetch;

		expect(await validateGoogleToken(makeEnv(), "a".repeat(MAX_GOOGLE_TOKEN_LENGTH + 1))).toEqual(
			invalid,
		);
		expect(fetched).toBe(false);
	});

	test("fails closed on JWKS HTTP, JSON, and response-shape errors", async () => {
		const responses = [
			new Response("unavailable", { status: 503 }),
			new Response("not json", { status: 200 }),
			Response.json({ not_keys: [] }),
		];

		for (const response of responses) {
			clearGoogleKeyCache();
			globalThis.fetch = (async () => response) as unknown as typeof fetch;
			expect(await validateGoogleToken(makeEnv(), tokenFor("key-1"))).toEqual(invalid);
		}
	});

	test("fails closed when a matching JWK cannot be imported", async () => {
		globalThis.fetch = (async () =>
			Response.json({
				keys: [{ kid: "key-1", kty: "definitely-not-rsa" }],
			})) as unknown as typeof fetch;

		expect(await validateGoogleToken(makeEnv(), tokenFor("key-1"))).toEqual(invalid);
	});

	test("refreshes a cached JWKS once when a new key id appears", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return Response.json({ keys: [{ kid: calls === 1 ? "old-key" : "other-key" }] });
		}) as unknown as typeof fetch;

		const token = tokenFor("new-key");
		expect(await validateGoogleToken(makeEnv(), token)).toEqual(invalid);
		expect(calls).toBe(1);

		expect(await validateGoogleToken(makeEnv(), token)).toEqual(invalid);
		expect(calls).toBe(2);

		expect(await validateGoogleToken(makeEnv(), tokenFor("random-attacker-key"))).toEqual(invalid);
		expect(calls).toBe(2);
	});

	test("the write gate turns malformed Google credentials into 401, not 500", async () => {
		const env = makeEnv();
		const request = new Request("https://drop.test/api/drop/lisa", {
			method: "POST",
			headers: { Authorization: "Google !.!.!" },
		});

		const response = await handleAPI(request, env, new URL(request.url), makeCtx());

		expect(response.status).toBe(401);
		expect(env.DB.raw.query("SELECT COUNT(*) AS n FROM drops").get()).toEqual({ n: 0 });
	});
});
