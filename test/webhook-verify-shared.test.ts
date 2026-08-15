import { describe, expect, test } from "bun:test";
import { verify } from "./helpers/verify";

// The schemes with no cryptography in them: the request carries a shared secret
// and we compare it. Weaker than a signature -- the same value rides every
// request, so anyone who captures one can replay forever -- and popular anyway. A
// provider that offers nothing else is better verified this way than not at all.
//
// There is no body signature here and nothing to put a replay window on, so the
// matrix is the one that applies: the right value passes, a near-miss rejects, an
// absent credential rejects, and a receiver with nothing configured fails closed
// rather than waving everything through.

const NOW = 1614265330_000;

describe("bearer", () => {
	const config = { secret: "tok_abc123" };

	test("the right token passes", async () => {
		const result = await verify({
			mode: "bearer",
			config,
			body: "{}",
			headers: { authorization: "Bearer tok_abc123" },
			now: NOW,
		});
		expect(result.verified).toBe(1);
	});

	test("a one-character difference rejects", async () => {
		const result = await verify({
			mode: "bearer",
			config,
			body: "{}",
			headers: { authorization: "Bearer tok_abc124" },
			now: NOW,
		});
		expect(result.verified).toBe(0);
	});

	test("a correct token under the wrong scheme rejects", async () => {
		// `Basic tok_abc123` is not a bearer credential, however right the bytes are.
		const result = await verify({
			mode: "bearer",
			config,
			body: "{}",
			headers: { authorization: "Basic tok_abc123" },
			now: NOW,
		});
		expect(result.verified).toBe(0);
	});

	test("no Authorization header rejects", async () => {
		const result = await verify({ mode: "bearer", config, body: "{}", now: NOW });
		expect(result.verified).toBe(0);
	});

	test("a receiver with no secret configured fails closed", async () => {
		const result = await verify({
			mode: "bearer",
			config: {},
			body: "{}",
			headers: { authorization: "Bearer anything" },
			now: NOW,
		});
		expect(result.verified).toBe(0);
		expect(result.reason).toBe("no secret configured");
	});
});

describe("basic", () => {
	// btoa("hookuser:hookpass")
	const CREDENTIAL = "aG9va3VzZXI6aG9va3Bhc3M=";
	const config = { username: "hookuser", password: "hookpass" };

	test("the right credential passes", async () => {
		const result = await verify({
			mode: "basic",
			config,
			body: "{}",
			headers: { authorization: `Basic ${CREDENTIAL}` },
			now: NOW,
		});
		expect(result.verified).toBe(1);
	});

	test("the credential is compared decoded, so unpadded base64 still passes", async () => {
		// Padding is an encoding detail, not part of the credential. Comparing the
		// encoded forms would reject a correct user and password over a trailing `=`.
		const result = await verify({
			mode: "basic",
			config,
			body: "{}",
			headers: { authorization: `Basic ${CREDENTIAL.replace(/=+$/, "")}` },
			now: NOW,
		});
		expect(result.verified).toBe(1);
	});

	test("the right user with the wrong password rejects", async () => {
		const result = await verify({
			mode: "basic",
			config,
			body: "{}",
			headers: { authorization: `Basic ${btoa("hookuser:wrong")}` },
			now: NOW,
		});
		expect(result.verified).toBe(0);
	});

	test("a whole `user:pass` given as the secret works too", async () => {
		const result = await verify({
			mode: "basic",
			config: { secret: "hookuser:hookpass" },
			body: "{}",
			headers: { authorization: `Basic ${CREDENTIAL}` },
			now: NOW,
		});
		expect(result.verified).toBe(1);
	});

	test("a credential that is not base64 rejects instead of throwing", async () => {
		// It has to come back as a 401. An exception here would escape into the
		// receive path's 503, which is the one status that tells a provider to retry
		// -- so a malformed header would turn into a retry storm.
		const result = await verify({
			mode: "basic",
			config,
			body: "{}",
			headers: { authorization: "Basic !!!not-base64!!!" },
			now: NOW,
		});
		expect(result.verified).toBe(0);
	});

	test("a receiver with nothing configured fails closed", async () => {
		const result = await verify({
			mode: "basic",
			config: {},
			body: "{}",
			headers: { authorization: `Basic ${CREDENTIAL}` },
			now: NOW,
		});
		expect(result.verified).toBe(0);
	});
});

describe("header", () => {
	const config = { header: "x-api-token", secret: "s3cr3t-value" };

	test("the right value passes", async () => {
		const result = await verify({
			mode: "header",
			config,
			body: "{}",
			headers: { "x-api-token": "s3cr3t-value" },
			now: NOW,
		});
		expect(result.verified).toBe(1);
	});

	test("a wrong value rejects", async () => {
		const result = await verify({
			mode: "header",
			config,
			body: "{}",
			headers: { "x-api-token": "s3cr3t-valuf" },
			now: NOW,
		});
		expect(result.verified).toBe(0);
	});

	test("the right value in the wrong header rejects", async () => {
		const result = await verify({
			mode: "header",
			config,
			body: "{}",
			headers: { "x-other-token": "s3cr3t-value" },
			now: NOW,
		});
		expect(result.verified).toBe(0);
	});

	test("a receiver naming no header fails closed", async () => {
		const result = await verify({
			mode: "header",
			config: { secret: "s3cr3t-value" },
			body: "{}",
			headers: { "x-api-token": "s3cr3t-value" },
			now: NOW,
		});
		expect(result.verified).toBe(0);
		expect(result.reason).toContain("header is required");
	});
});

describe("query", () => {
	const config = { secret: "url-token" };

	test("the default ?token parameter passes", async () => {
		const result = await verify({
			mode: "query",
			config,
			body: "{}",
			url: "https://drop.test/h/lisa/hook?token=url-token",
			now: NOW,
		});
		expect(result.verified).toBe(1);
	});

	test("a named parameter passes", async () => {
		const result = await verify({
			mode: "query",
			config: { ...config, param: "key" },
			body: "{}",
			url: "https://drop.test/h/lisa/hook?key=url-token",
			now: NOW,
		});
		expect(result.verified).toBe(1);
	});

	test("a wrong value rejects", async () => {
		const result = await verify({
			mode: "query",
			config,
			body: "{}",
			url: "https://drop.test/h/lisa/hook?token=url-tokem",
			now: NOW,
		});
		expect(result.verified).toBe(0);
	});

	test("no parameter at all rejects", async () => {
		const result = await verify({
			mode: "query",
			config,
			body: "{}",
			url: "https://drop.test/h/lisa/hook",
			now: NOW,
		});
		expect(result.verified).toBe(0);
	});
});
