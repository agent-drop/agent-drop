import { describe, expect, test } from "bun:test";
import { handleAPI } from "../src/api/router";
import {
	allowAll,
	denyAll,
	dropStatus,
	jsonRequest,
	makeCtx,
	makeEnv,
	seedApiKey,
	seedDropToken,
	seedPendingDrop,
	TEST_ADMIN_KEY,
	type TestEnv,
} from "./helpers/env";

const BASE = "https://drop.test";
const IP = "203.0.113.7";

function call(env: TestEnv, request: Request) {
	return handleAPI(request, env, new URL(request.url), makeCtx());
}

function get(path: string, headers: Record<string, string> = {}) {
	return new Request(BASE + path, { headers: { "CF-Connecting-IP": IP, ...headers } });
}

// REGRESSION: there was no rate limiting anywhere in the worker, so an `ad_`
// API key, a drop token or the master admin key could all be brute-forced at
// whatever rate the attacker could sustain, and a leaked drop link was an
// unbounded upload firehose.
//
// Note what this is and is not: the Workers binding counts PER COLOCATION, so
// the effective ceiling is roughly (limit x colos reached). It throttles abuse;
// it is not a hard quota.
describe("failed authentication is rate limited per client IP", () => {
	test("a rejected API key burns a token keyed by CF-Connecting-IP", async () => {
		const limiter = allowAll();
		const env = makeEnv({ AUTH_RATE_LIMIT: limiter });

		const res = await call(env, get("/api/inbox/lisa", { Authorization: "Bearer ad_nope" }));

		expect(res.status).toBe(401);
		expect(limiter.keys).toHaveLength(1);
		expect(limiter.keys[0]).toContain(IP);
	});

	test("a rejected admin key burns a token", async () => {
		const limiter = allowAll();
		const env = makeEnv({ AUTH_RATE_LIMIT: limiter });

		const res = await call(env, get("/api/keys", { Authorization: "Bearer guess" }));

		expect(res.status).toBe(403);
		expect(limiter.keys).toHaveLength(1);
	});

	test("a rejected drop token burns a token", async () => {
		const limiter = allowAll();
		const env = makeEnv({ AUTH_RATE_LIMIT: limiter });

		const res = await call(
			env,
			new Request(`${BASE}/api/drop/lisa?auth=guess`, {
				method: "POST",
				headers: { "CF-Connecting-IP": IP },
			}),
		);

		expect(res.status).toBe(401);
		expect(limiter.keys).toHaveLength(1);
	});

	test("once the bucket is empty the caller gets 429, not another attempt", async () => {
		const env = makeEnv({ AUTH_RATE_LIMIT: denyAll() });

		const res = await call(env, get("/api/inbox/lisa", { Authorization: "Bearer ad_nope" }));

		expect(res.status).toBe(429);
	});

	test("a successful request burns nothing", async () => {
		const limiter = allowAll();
		const env = makeEnv({ AUTH_RATE_LIMIT: limiter });
		await seedApiKey(env, "ad_good", { permissions: "read" });

		const res = await call(env, get("/api/inbox/lisa", { Authorization: "Bearer ad_good" }));

		expect(res.status).toBe(200);
		expect(limiter.keys).toHaveLength(0);
	});

	test("the admin key burns nothing", async () => {
		const limiter = allowAll();
		const env = makeEnv({ AUTH_RATE_LIMIT: limiter });

		const res = await call(env, get("/api/boxes", { Authorization: `Bearer ${TEST_ADMIN_KEY}` }));

		expect(res.status).toBe(200);
		expect(limiter.keys).toHaveLength(0);
	});

	test("an exhausted bucket still does not blanket-block valid credentials", async () => {
		// The limiter guards the failure path only -- a legitimate agent sharing a
		// NAT egress IP with an attacker must keep working.
		const env = makeEnv({ AUTH_RATE_LIMIT: denyAll() });
		await seedApiKey(env, "ad_good", { permissions: "read" });

		const res = await call(env, get("/api/inbox/lisa", { Authorization: "Bearer ad_good" }));

		expect(res.status).toBe(200);
	});
});

describe("drop-token uploads are rate limited per token", () => {
	test("an accepted drop token burns an upload token, keyed by neither the raw token nor the IP", async () => {
		const limiter = allowAll();
		const env = makeEnv({ UPLOAD_RATE_LIMIT: limiter });
		await seedDropToken(env, "tok-lisa", "lisa");
		await seedPendingDrop(env, { id: "drop-rl-1", inbox: "lisa" });

		const res = await call(
			env,
			jsonRequest(`${BASE}/api/upload/confirm?auth=tok-lisa`, { dropId: "drop-rl-1" }),
		);

		expect(res.status).toBe(200);
		expect(limiter.keys).toHaveLength(1);
		// The raw token is a bearer secret; it must not be handed to another
		// subsystem verbatim.
		expect(limiter.keys[0]).not.toContain("tok-lisa");
	});

	test("an exhausted upload bucket returns 429 and does not complete the drop", async () => {
		const env = makeEnv({ UPLOAD_RATE_LIMIT: denyAll() });
		await seedDropToken(env, "tok-lisa", "lisa");
		await seedPendingDrop(env, { id: "drop-rl-2", inbox: "lisa" });

		const res = await call(
			env,
			jsonRequest(`${BASE}/api/upload/confirm?auth=tok-lisa`, { dropId: "drop-rl-2" }),
		);

		expect(res.status).toBe(429);
		expect(dropStatus(env, "drop-rl-2")).toBe("pending");
	});

	test("API-key uploads do not touch the drop-token bucket", async () => {
		const limiter = allowAll();
		const env = makeEnv({ UPLOAD_RATE_LIMIT: limiter });
		await seedApiKey(env, "ad_writer", { permissions: "write" });
		await seedPendingDrop(env, { id: "drop-rl-3", inbox: "lisa" });

		const res = await call(
			env,
			jsonRequest(
				`${BASE}/api/upload/confirm`,
				{ dropId: "drop-rl-3" },
				{ Authorization: "Bearer ad_writer" },
			),
		);

		expect(res.status).toBe(200);
		expect(limiter.keys).toHaveLength(0);
	});
});

describe("a missing rate-limit binding never breaks a request", () => {
	test("failed auth still returns 401 with no binding configured", async () => {
		const env = makeEnv({ AUTH_RATE_LIMIT: undefined, UPLOAD_RATE_LIMIT: undefined });

		const res = await call(env, get("/api/inbox/lisa", { Authorization: "Bearer ad_nope" }));

		expect(res.status).toBe(401);
	});

	test("a drop-token upload still succeeds with no binding configured", async () => {
		const env = makeEnv({ AUTH_RATE_LIMIT: undefined, UPLOAD_RATE_LIMIT: undefined });
		await seedDropToken(env, "tok-lisa", "lisa");
		await seedPendingDrop(env, { id: "drop-rl-4", inbox: "lisa" });

		const res = await call(
			env,
			jsonRequest(`${BASE}/api/upload/confirm?auth=tok-lisa`, { dropId: "drop-rl-4" }),
		);

		expect(res.status).toBe(200);
	});

	test("a limiter that throws is not allowed to take the request down", async () => {
		const exploding = {
			limit: async () => {
				throw new Error("rate limiter unavailable");
			},
		} as unknown as RateLimit;
		const env = makeEnv({ AUTH_RATE_LIMIT: exploding });

		const res = await call(env, get("/api/inbox/lisa", { Authorization: "Bearer ad_nope" }));

		expect(res.status).toBe(401);
	});
});
