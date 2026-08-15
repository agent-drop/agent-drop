/**
 * The two limits in front of the public receiver, and what each one is for.
 *
 * They are not alternatives. `HOOK_RATE_LIMIT` counts per colocation and fails
 * open, so it throttles a burst and bounds nothing; `daily_cap` is counted in
 * D1, cannot fail open, and is the actual bound on a table that would otherwise
 * grow forever. The tests below assert both halves of that, including the
 * uncomfortable one: a limiter that is down lets the request through.
 *
 * Rows are read back with `env.DB.raw.query`, because "answered 429" and "stored
 * nothing" are two different claims and only the second one matters.
 */

import { describe, expect, test } from "bun:test";
import { serveWebhook } from "../src/lib/webhook-receive";
import { CAP_WINDOW_MS } from "../src/lib/webhook-throttle";
import { makeBucket, makeCtx, makeEnv, seedReceiver, type TestEnv } from "./helpers/env";

const BASE = "https://drop.test";
const NOW = 1_800_000_000_000;

function limiter(success: boolean) {
	const keys: string[] = [];
	return Object.assign(
		{
			limit: async ({ key }: { key?: string }) => {
				keys.push(key ?? "");
				return { success };
			},
		},
		{ keys },
	) as RateLimit & { keys: string[] };
}

function throwingLimiter() {
	return {
		limit: async () => {
			throw new Error("rate limiter unavailable");
		},
	} as unknown as RateLimit;
}

async function post(env: TestEnv, path: string, body = '{"a":1}') {
	const url = new URL(`${BASE}${path}`);
	return serveWebhook(
		new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }),
		env,
		url,
		makeCtx(),
	);
}

function eventCount(env: TestEnv): number {
	const row = env.DB.raw.query("SELECT COUNT(*) AS n FROM webhook_events").get() as { n: number };
	return row.n;
}

/** Rows dated inside the cap window, written straight in. */
async function seedEvents(env: TestEnv, receiverId: string, count: number, agoMs = 60_000) {
	for (let i = 0; i < count; i++) {
		await env.DB.prepare(
			`INSERT INTO webhook_events
				(id, receiver_id, inbox, slug, method, status, created_at, expires_at)
			 VALUES (?, ?, 'lisa', 'gh', 'POST', 'queued', ?, ?)`,
		)
			.bind(`seed-${i}`, receiverId, Date.now() - agoMs, Date.now() + 86_400_000)
			.run();
	}
}

describe("the burst limiter", () => {
	test("keys on the receiver id, so one noisy receiver cannot throttle another", async () => {
		const hook = limiter(true);
		const env = makeEnv({ BUCKET: makeBucket(), HOOK_RATE_LIMIT: hook });
		const id = await seedReceiver(env, { inbox: "lisa", slug: "gh" });

		expect((await post(env, "/h/lisa/gh")).status).toBe(200);
		expect(hook.keys).toEqual([`hook:${id}`]);
	});

	test("answers 429 with a Retry-After and stores nothing", async () => {
		const env = makeEnv({ BUCKET: makeBucket(), HOOK_RATE_LIMIT: limiter(false) });
		await seedReceiver(env, { inbox: "lisa", slug: "gh" });

		const res = await post(env, "/h/lisa/gh");

		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBe("60");
		expect(eventCount(env)).toBe(0);
	});

	// A throttle that turns its own outage into an outage of the thing it protects
	// is worse than the abuse it prevents. Both shapes of "not working" fail open.
	test("fails open when the limiter throws", async () => {
		const env = makeEnv({ BUCKET: makeBucket(), HOOK_RATE_LIMIT: throwingLimiter() });
		await seedReceiver(env, { inbox: "lisa", slug: "gh" });

		expect((await post(env, "/h/lisa/gh")).status).toBe(200);
		expect(eventCount(env)).toBe(1);
	});

	test("fails open when the binding is missing entirely", async () => {
		const env = makeEnv({ BUCKET: makeBucket(), HOOK_RATE_LIMIT: undefined });
		await seedReceiver(env, { inbox: "lisa", slug: "gh" });

		expect((await post(env, "/h/lisa/gh")).status).toBe(200);
		expect(eventCount(env)).toBe(1);
	});

	// It sheds load, so it runs before the body is read -- and an unregistered slug
	// never reaches it at all, since there is no receiver to key on.
	test("an unknown slug is still a 404 and burns no token", async () => {
		const hook = limiter(false);
		const env = makeEnv({ BUCKET: makeBucket(), HOOK_RATE_LIMIT: hook });

		expect((await post(env, "/h/lisa/nope")).status).toBe(404);
		expect(hook.keys).toEqual([]);
	});
});

describe("the daily cap", () => {
	test("is not consulted at all when the receiver set none", async () => {
		const env = makeEnv({ BUCKET: makeBucket() });
		const id = await seedReceiver(env, { inbox: "lisa", slug: "gh", dailyCap: null });
		await seedEvents(env, id, 3);

		expect((await post(env, "/h/lisa/gh")).status).toBe(200);
		expect(eventCount(env)).toBe(4);
	});

	test("accepts up to the cap and refuses the one past it", async () => {
		const env = makeEnv({ BUCKET: makeBucket() });
		const id = await seedReceiver(env, { inbox: "lisa", slug: "gh", dailyCap: 4 });
		await seedEvents(env, id, 3);

		expect((await post(env, "/h/lisa/gh", '{"n":4}')).status).toBe(200);
		expect(eventCount(env)).toBe(4);

		const refused = await post(env, "/h/lisa/gh", '{"n":5}');
		expect(refused.status).toBe(429);
		expect((await refused.json()) as unknown).toEqual({ error: "daily event cap reached" });
		expect(eventCount(env)).toBe(4);
	});

	// The earliest moment the answer could actually change.
	test("Retry-After is the time until the oldest row leaves the window", async () => {
		const env = makeEnv({ BUCKET: makeBucket() });
		const id = await seedReceiver(env, { inbox: "lisa", slug: "gh", dailyCap: 1 });
		await seedEvents(env, id, 1, 6 * 3_600_000);

		const res = await post(env, "/h/lisa/gh");

		expect(res.status).toBe(429);
		const retry = Number(res.headers.get("Retry-After"));
		// 24h window minus the 6h the row has already served, give or take the clock.
		expect(retry).toBeGreaterThan(17 * 3600);
		expect(retry).toBeLessThanOrEqual(18 * 3600 + 5);
	});

	test("rows older than the window do not count towards it", async () => {
		const env = makeEnv({ BUCKET: makeBucket() });
		const id = await seedReceiver(env, { inbox: "lisa", slug: "gh", dailyCap: 2 });
		await seedEvents(env, id, 5, CAP_WINDOW_MS + 60_000);

		expect((await post(env, "/h/lisa/gh")).status).toBe(200);
		expect(eventCount(env)).toBe(6);
	});

	test("counts only this receiver's rows", async () => {
		const env = makeEnv({ BUCKET: makeBucket() });
		const capped = await seedReceiver(env, { inbox: "lisa", slug: "gh", dailyCap: 2 });
		const other = await seedReceiver(env, { inbox: "lisa", slug: "other" });
		// Ten rows in the same box and the same window, on a different receiver.
		await seedEvents(env, other, 10);

		expect((await post(env, "/h/lisa/gh")).status).toBe(200);
		expect((await post(env, "/h/lisa/gh", '{"n":2}')).status).toBe(200);
		// Now it has two of its own, and only now does it stop.
		expect((await post(env, "/h/lisa/gh", '{"n":3}')).status).toBe(429);
		expect(capped).not.toBe(other);
	});

	// The cap bounds table growth, and a flood of garbage that fails verification
	// grows the table exactly as fast as a flood of real deliveries.
	test("a rejected row counts towards the cap", async () => {
		const env = makeEnv({ BUCKET: makeBucket() });
		const id = await seedReceiver(env, { inbox: "lisa", slug: "gh", dailyCap: 2 });
		await seedEvents(env, id, 2);
		await env.DB.prepare("UPDATE webhook_events SET status = 'rejected' WHERE receiver_id = ?")
			.bind(id)
			.run();

		const res = await post(env, "/h/lisa/gh");

		expect(res.status).toBe(429);
		expect(eventCount(env)).toBe(2);
	});

	// Phase 3 settled that a handshake's ANSWER is the whole product and does not
	// depend on its row. Refusing a Zoom CRC over a row cap costs the operator
	// their endpoint registration -- six failures and Zoom disables it -- to save
	// one row. The burst limiter is what stops a handshake flood.
	test("does not refuse a handshake", async () => {
		const env = makeEnv({ BUCKET: makeBucket() });
		const id = await seedReceiver(env, {
			inbox: "lisa",
			slug: "zoom",
			dailyCap: 1,
			handshakeMode: "zoom",
			handshakeConfig: { secret: "zoomSecret123" },
		});
		await seedEvents(env, id, 5);

		const res = await post(
			env,
			"/h/lisa/zoom",
			JSON.stringify({
				event: "endpoint.url_validation",
				payload: { plainToken: "qgg8vlvZRS6UYooatFL8Aw" },
			}),
		);

		expect(res.status).toBe(200);
		const answer = (await res.json()) as { plainToken: string; encryptedToken: string };
		expect(answer.plainToken).toBe("qgg8vlvZRS6UYooatFL8Aw");
		// Computed with `openssl dgst -sha256 -hmac zoomSecret123` outside this code.
		expect(answer.encryptedToken).toBe(
			"3ee215dfbe53223d6ab24ea678f99d586ea8dc959ce3f737482a1a702f29ac2f",
		);
	});

	test("but an ordinary delivery to that same receiver is still refused", async () => {
		const env = makeEnv({ BUCKET: makeBucket() });
		const id = await seedReceiver(env, {
			inbox: "lisa",
			slug: "zoom",
			dailyCap: 1,
			handshakeMode: "zoom",
			handshakeConfig: { secret: "zoomSecret123" },
		});
		await seedEvents(env, id, 5);

		expect((await post(env, "/h/lisa/zoom", '{"event":"meeting.started"}')).status).toBe(429);
	});

	test("a cap of 0 is no cap, matching a NULL column", async () => {
		const env = makeEnv({ BUCKET: makeBucket() });
		const id = await seedReceiver(env, { inbox: "lisa", slug: "gh", dailyCap: 0 });
		await seedEvents(env, id, 3);

		expect((await post(env, "/h/lisa/gh")).status).toBe(200);
	});
});

describe("what the limits do NOT do", () => {
	test("a disabled receiver answers 403 before either limit runs", async () => {
		const hook = limiter(false);
		const env = makeEnv({ BUCKET: makeBucket(), HOOK_RATE_LIMIT: hook });
		await seedReceiver(env, { inbox: "lisa", slug: "gh", enabled: 0, dailyCap: 1 });

		expect((await post(env, "/h/lisa/gh")).status).toBe(403);
		expect(hook.keys).toEqual([]);
	});

	test("a method the receiver does not allow is 405, not 429", async () => {
		const env = makeEnv({ BUCKET: makeBucket(), HOOK_RATE_LIMIT: limiter(false) });
		await seedReceiver(env, { inbox: "lisa", slug: "gh", methods: "POST" });
		const url = new URL(`${BASE}/h/lisa/gh`);

		const res = await serveWebhook(new Request(url), env, url, makeCtx());

		expect(res.status).toBe(405);
	});
});
