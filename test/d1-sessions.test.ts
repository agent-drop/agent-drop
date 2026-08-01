import { describe, expect, test } from "bun:test";
import { handleAPI } from "../src/api/router";
import { handleInbox } from "../src/api/inbox";
import { serveHostedSite } from "../src/lib/hosting";
import {
	makeBucket,
	makeCtx,
	makeEnv,
	seedApiKey,
	seedPendingDrop,
	TEST_ADMIN_KEY,
	type TestEnv,
} from "./helpers/env";

const BASE = "https://drop.test";

function get(env: TestEnv, path: string, auth: string) {
	const req = new Request(BASE + path, { headers: { Authorization: `Bearer ${auth}` } });
	return handleAPI(req, env, new URL(req.url), makeCtx());
}

// Read paths run inside a D1 session so a replica can answer them. Nothing about
// the RESULTS changes -- a single SQLite file has one copy of the data -- so what
// these tests pin is that the read paths actually go through a session, and with
// which constraint. Without that, "adopted the Sessions API" is unverifiable.
describe("read paths run in a first-unconstrained D1 session", () => {
	test("GET /api/inbox/:name", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_r", { permissions: "read" });
		await seedPendingDrop(env, { id: "d1", inbox: "lisa", status: "completed" });

		const res = await get(env, "/api/inbox/lisa", "ad_r");

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ inbox: "lisa", count: 1 });
		expect(env.DB.sessions).toEqual(["first-unconstrained"]);
	});

	test("a single request opens exactly one session for all of its queries", async () => {
		const env = makeEnv();
		await seedPendingDrop(env, { id: "d1", inbox: "lisa", status: "completed" });

		// /latest reads the drop and then writes read_at -- two queries, one session.
		const res = await handleInbox(env, "lisa", "/latest", new URL(`${BASE}/api/inbox/lisa/latest`));

		expect(res.status).toBe(200);
		expect(env.DB.sessions).toEqual(["first-unconstrained"]);
	});

	test("the mark-as-read write inside that session still lands", async () => {
		const env = makeEnv();
		await seedPendingDrop(env, { id: "d1", inbox: "lisa", status: "completed" });

		await handleInbox(env, "lisa", "/latest", new URL(`${BASE}/api/inbox/lisa/latest`));

		const row = env.DB.raw.query("SELECT read_at FROM drops WHERE id = 'd1'").get() as {
			read_at: number | null;
		};
		expect(row.read_at).toBeGreaterThan(0);
	});

	test("GET /api/drops", async () => {
		const env = makeEnv();
		const res = await get(env, "/api/drops?limit=5", TEST_ADMIN_KEY);

		expect(res.status).toBe(200);
		expect(env.DB.sessions).toEqual(["first-unconstrained"]);
	});

	test("GET /api/boxes uses ONE session for both of its queries", async () => {
		const env = makeEnv();
		await seedPendingDrop(env, { id: "d1", inbox: "lisa", status: "completed" });

		const res = await get(env, "/api/boxes", TEST_ADMIN_KEY);

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ count: 1 });
		// Two queries (boxes + active token counts), one session -- otherwise the
		// token counts could come from an older replica than the box list.
		expect(env.DB.sessions).toEqual(["first-unconstrained"]);
	});

	test("the hosted-site registry lookup", async () => {
		const env = makeEnv({ BUCKET: makeBucket({ "sites/lisa/promo/index.html": "<h1>hi</h1>" }) });
		env.DB.raw
			.query(
				"INSERT INTO hosted_sites (id, inbox, site, file_count, total_bytes, created_at, updated_at) VALUES (?, 'lisa', 'promo', 1, 10, ?, ?)",
			)
			.run(crypto.randomUUID(), Date.now(), Date.now());

		const url = new URL(`${BASE}/f/lisa/promo/`);
		const res = await serveHostedSite(new Request(url), env, url);

		expect(res.status).toBe(200);
		expect(env.DB.sessions).toEqual(["first-unconstrained"]);
	});
});

describe("write paths are not put on a replica", () => {
	test("POST /api/drop/:name opens no read session", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_w", { permissions: "write" });

		const res = await handleAPI(
			new Request(`${BASE}/api/drop/lisa`, {
				method: "POST",
				headers: { Authorization: "Bearer ad_w", "Content-Type": "application/json" },
				body: JSON.stringify({ subject: "hi", text: "yo" }),
			}),
			env,
			new URL(`${BASE}/api/drop/lisa`),
			makeCtx(),
		);

		expect(res.status).toBe(201);
		expect(env.DB.sessions).toEqual([]);
	});
});
