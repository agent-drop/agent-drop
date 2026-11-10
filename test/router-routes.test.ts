/**
 * The router's contract, pinned route by route.
 *
 * This suite exists to make the phase-6 router rewrite safe. It was written and
 * run GREEN against the old 340-line sequential-regex router BEFORE a line of
 * the rewrite existed, so every assertion here describes behavior that shipped,
 * not behavior the new code happens to have.
 *
 * It deliberately drives the REAL handlers rather than doubles: the thing most
 * likely to break in a dispatch rewrite is not "was a function called" but
 * "was it called with the right inbox, the right sub-path, the right URL" --
 * and a recording double answers the first question while quietly passing the
 * second.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleAPI } from "../src/api/router";
import type { Env } from "../src/types";
import { makeEmail } from "./helpers/email";
import {
	denyAll,
	makeBucket,
	makeCtx,
	makeEnv,
	seedApiKey,
	seedDropToken,
	seedPendingDrop,
	TEST_ADMIN_KEY,
	TEST_DOMAIN,
	type TestEnv,
} from "./helpers/env";

const BASE = `https://${TEST_DOMAIN}`;
const ADMIN = { Authorization: `Bearer ${TEST_ADMIN_KEY}` };

function call(env: TestEnv, request: Request) {
	return handleAPI(request, env, new URL(request.url), makeCtx());
}

function get(env: TestEnv, path: string, headers: Record<string, string> = {}) {
	return call(env, new Request(`${BASE}${path}`, { headers }));
}

function send(
	env: TestEnv,
	method: string,
	path: string,
	headers: Record<string, string> = {},
	body?: unknown,
) {
	return call(
		env,
		new Request(`${BASE}${path}`, {
			method,
			headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
}

/** `Response.json()` is typed `Promise<unknown>` under the worker types. */
async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

// aws4fetch goes through global fetch. Stubbing it keeps the suite offline and
// lets a route assert which R2 key it signed or listed.
const realFetch = globalThis.fetch;
let fetched: string[] = [];

beforeEach(() => {
	fetched = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		fetched.push(url);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		if (method === "GET") {
			return new Response(
				'<ListPartsResult><Part><PartNumber>1</PartNumber><ETag>"abc"</ETag></Part></ListPartsResult>',
				{ status: 200 },
			);
		}
		return new Response("<CompleteMultipartUploadResult/>", { status: 200 });
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("unauthenticated routes", () => {
	test("GET /api/health", async () => {
		const res = await get(makeEnv(), "/api/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; ts: number };
		expect(body.ok).toBe(true);
		expect(typeof body.ts).toBe("number");
	});

	test("GET /api/config exposes the public client id, never the private one", async () => {
		const res = await get(makeEnv(), "/api/config");
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual({ google_client_id: "google-test-public" });
	});

	test("GET /api/config falls back to GOOGLE_CLIENT_ID when no public one is set", async () => {
		const env = makeEnv({ GOOGLE_CLIENT_ID_PUBLIC: undefined });
		expect(await json(await get(env, "/api/config"))).toEqual({
			google_client_id: "google-test",
		});
	});

	test("OPTIONS on a browser route answers with the CORS preflight", async () => {
		const res = await send(makeEnv(), "OPTIONS", "/api/drop/lisa");
		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(`https://${TEST_DOMAIN}`);
		expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
	});

	test("OPTIONS on an admin route answers with no CORS headers at all", async () => {
		const res = await send(makeEnv(), "OPTIONS", "/api/keys");
		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});
});

describe("dispatch quirks that predate the rewrite", () => {
	// These are not endorsements. They are the behavior that shipped, pinned so a
	// dispatch rewrite changes it deliberately or not at all.

	test("/api/health and /api/config ignore the method", async () => {
		// Neither route checks `method`, so a POST answers exactly like a GET.
		const res = await send(makeEnv(), "POST", "/api/health");
		expect(res.status).toBe(200);
		expect(await json(res)).toHaveProperty("ok", true);
	});

	test("admin routes match by PREFIX, not by path segment", async () => {
		// `path.startsWith("/api/keys")` also matches `/api/keysfoo`, which then
		// falls through handleKeys' own sub-routing to the list. Segment-exact
		// matching would be a small improvement; it is deliberately NOT taken here,
		// because this phase's contract is behavior-identical dispatch.
		const res = await get(makeEnv(), "/api/keysfoo", ADMIN);
		expect(res.status).toBe(200);
		expect(await json(res)).toHaveProperty("keys");
	});

	test("OPTIONS short-circuits every path, known or not", async () => {
		const res = await send(makeEnv(), "OPTIONS", "/api/does-not-exist");
		expect(res.status).toBe(200);
	});

	test("an unmatched path with NO credential is a 401, not a 404", async () => {
		// The API-key gate runs before the second tier of routes, so an anonymous
		// caller cannot tell a real path from a fake one. That is the intended
		// ordering, and it is easy to lose in a flat route table.
		const res = await get(makeEnv(), "/api/nope");
		expect(res.status).toBe(401);
		expect(await json(res)).toEqual({ error: "invalid api key" });
	});

	test("a nested path under a tier-1 route falls through to the key gate", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_writer", { permissions: "write" });
		const res = await send(
			env,
			"POST",
			"/api/upload/presign/lisa/extra",
			{ Authorization: "Bearer ad_writer" },
			{ fileName: "a" },
		);
		expect(res.status).toBe(404);
	});

	test("a trailing slash where an inbox belongs matches nothing", async () => {
		// The inbox capture rejects an empty segment, so this falls through to the
		// 404 instead of reaching the write gate with an empty box name.
		const env = makeEnv();
		await seedApiKey(env, "ad_writer", { permissions: "write" });
		const res = await call(
			env,
			new Request(`${BASE}/api/drop/`, {
				method: "POST",
				body: new FormData(),
				headers: { Authorization: "Bearer ad_writer" },
			}),
		);
		expect(res.status).toBe(404);
	});

	test("GET /api/inbox/:name/ passes the trailing slash through as the sub-path", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_reader", { permissions: "read" });
		await seedPendingDrop(env, { id: "d1", inbox: "lisa", status: "completed" });
		// The router hands the sub-path through verbatim, trailing slash included;
		// handleInbox's own matching is what decides this lands on the listing.
		const res = await get(env, "/api/inbox/lisa/", { Authorization: "Bearer ad_reader" });
		expect(res.status).toBe(200);
		expect(await json(res)).toMatchObject({ count: 1 });
	});
});

describe("admin-only routes", () => {
	const adminRoutes = [
		["/api/keys", "keys"],
		["/api/targets", "targets"],
		["/api/users", "users"],
		["/api/rules", "rules"],
		["/api/masks", "masks"],
	] as const;

	for (const [path, collection] of adminRoutes) {
		test(`GET ${path} requires the admin key`, async () => {
			const res = await get(makeEnv(), path);
			expect(res.status).toBe(403);
			expect(await json(res)).toEqual({ error: "admin required" });
		});

		test(`GET ${path} lists ${collection} for the admin key`, async () => {
			const res = await get(makeEnv(), path, ADMIN);
			expect(res.status).toBe(200);
			expect(await json(res)).toHaveProperty(collection);
		});
	}

	test("GET /api/deliveries dispatches to the rules handler", async () => {
		const res = await get(makeEnv(), "/api/deliveries", ADMIN);
		expect(res.status).toBe(200);
		expect(await json(res)).toHaveProperty("deliveries");
	});

	test("a write API key is not an admin key", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_writer", { permissions: "write" });
		const res = await get(env, "/api/keys", { Authorization: "Bearer ad_writer" });
		expect(res.status).toBe(403);
	});

	test("POST /api/keys mints a key", async () => {
		const env = makeEnv();
		const res = await send(env, "POST", "/api/keys", ADMIN, { name: "agent-1" });
		expect(res.status).toBe(201);
		const body = (await res.json()) as { key: string; name: string };
		expect(body.name).toBe("agent-1");
		expect(body.key).toStartWith("ad_");
	});

	test("DELETE /api/keys/:id reaches the sub-path route", async () => {
		const env = makeEnv();
		const created = (await (
			await send(env, "POST", "/api/keys", ADMIN, { name: "doomed" })
		).json()) as { key: string };
		const list = (await (await get(env, "/api/keys", ADMIN)).json()) as {
			keys: { id: string; name: string }[];
		};
		const id = list.keys.find((k) => k.name === "doomed")?.id;
		expect(id).toBeTruthy();
		expect(created.key).toBeTruthy();

		const res = await send(env, "DELETE", `/api/keys/${id}`, ADMIN);
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual({ deleted: true });
	});

	test("POST /api/users adds an allowed user", async () => {
		const res = await send(makeEnv(), "POST", "/api/users", ADMIN, { email: "a@example.com" });
		expect(res.status).toBe(201);
		expect(await json(res)).toEqual({ added: "a@example.com" });
	});

	test("DELETE /api/users/:email reaches the sub-path route", async () => {
		const env = makeEnv();
		await send(env, "POST", "/api/users", ADMIN, { email: "a@example.com" });
		const res = await send(env, "DELETE", "/api/users/a@example.com", ADMIN);
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual({ deleted: "a@example.com" });
	});

	test("POST /api/targets mints a drop token for a normalized inbox", async () => {
		const res = await send(makeEnv(), "POST", "/api/targets", ADMIN, { inbox: "Mr.Gray" });
		expect(res.status).toBe(201);
		const body = (await res.json()) as { inbox: string; token: string; url: string };
		expect(body.inbox).toBe("mrgray");
		expect(body.token).toBeTruthy();
	});

	test("a rejected admin credential burns a rate-limit token", async () => {
		const env = makeEnv({ AUTH_RATE_LIMIT: denyAll() });
		const res = await get(env, "/api/keys", { Authorization: "Bearer wrong" });
		expect(res.status).toBe(429);
		expect(await json(res)).toEqual({ error: "too many failed authentication attempts" });
	});

	test("admin responses carry no CORS headers", async () => {
		const res = await get(makeEnv(), "/api/keys", ADMIN);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});
});

describe("GET /api/drops and GET /api/boxes", () => {
	async function seedDrops(env: TestEnv) {
		await seedPendingDrop(env, { id: "d1", inbox: "lisa", status: "completed", createdAt: 1000 });
		await seedPendingDrop(env, { id: "d2", inbox: "bob", status: "completed", createdAt: 2000 });
	}

	test("/api/drops rejects an anonymous caller", async () => {
		expect((await get(makeEnv(), "/api/drops")).status).toBe(403);
	});

	test("/api/drops accepts the admin key", async () => {
		const env = makeEnv();
		await seedDrops(env);
		const res = await get(env, "/api/drops", ADMIN);
		expect(res.status).toBe(200);
		expect(await json(res)).toMatchObject({ count: 2 });
	});

	test("/api/drops accepts an API key with admin permissions", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_admin", { permissions: "admin" });
		await seedDrops(env);
		const res = await get(env, "/api/drops", { Authorization: "Bearer ad_admin" });
		expect(res.status).toBe(200);
	});

	test("/api/drops filters an admin API key to its inbox scope", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_lisa_admin", { permissions: "admin", inboxScope: "lisa" });
		await seedDrops(env);

		const body = (await (
			await get(env, "/api/drops", { Authorization: "Bearer ad_lisa_admin" })
		).json()) as { count: number; drops: { inbox: string }[] };

		expect(body.count).toBe(1);
		expect(body.drops.map((drop) => drop.inbox)).toEqual(["lisa"]);
	});

	test("/api/drops rejects an API key with only write permissions", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_writer", { permissions: "write" });
		const res = await get(env, "/api/drops", { Authorization: "Bearer ad_writer" });
		expect(res.status).toBe(403);
	});

	test("/api/drops honours limit, since and channel from the query string", async () => {
		const env = makeEnv();
		await seedDrops(env);
		const limited = (await (await get(env, "/api/drops?limit=1", ADMIN)).json()) as {
			count: number;
			drops: { id: string }[];
		};
		expect(limited.count).toBe(1);
		// Newest first.
		expect(limited.drops[0].id).toBe("d2");

		const since = (await (await get(env, "/api/drops?since=1500", ADMIN)).json()) as {
			count: number;
		};
		expect(since.count).toBe(1);

		const channel = (await (await get(env, "/api/drops?channel=email", ADMIN)).json()) as {
			count: number;
		};
		expect(channel.count).toBe(0);
	});

	test("/api/boxes groups drops by inbox and counts active tokens", async () => {
		const env = makeEnv();
		await seedDrops(env);
		await seedDropToken(env, "tok-lisa", "lisa");
		const res = await get(env, "/api/boxes", ADMIN);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			count: number;
			boxes: { inbox: string; active_tokens: number }[];
		};
		expect(body.count).toBe(2);
		expect(body.boxes.find((b) => b.inbox === "lisa")?.active_tokens).toBe(1);
		expect(body.boxes.find((b) => b.inbox === "bob")?.active_tokens).toBe(0);
	});

	test("/api/boxes filters drops and token counts to an admin API key's scope", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_lisa_admin", { permissions: "admin", inboxScope: "lisa" });
		await seedDrops(env);
		await seedDropToken(env, "tok-lisa", "lisa");
		await seedDropToken(env, "tok-bob", "bob");

		const body = (await (
			await get(env, "/api/boxes", { Authorization: "Bearer ad_lisa_admin" })
		).json()) as {
			count: number;
			boxes: { inbox: string; active_tokens: number }[];
		};

		expect(body).toEqual({
			count: 1,
			boxes: [expect.objectContaining({ inbox: "lisa", active_tokens: 1 })],
		});
	});

	test("/api/boxes rejects an anonymous caller", async () => {
		expect((await get(makeEnv(), "/api/boxes")).status).toBe(403);
	});

	test("POST /api/drops is not a route", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_admin", { permissions: "admin" });
		const res = await send(env, "POST", "/api/drops", { Authorization: "Bearer ad_admin" }, {});
		expect(res.status).toBe(404);
	});
});

describe("POST /api/drop/:name", () => {
	function form(fields: Record<string, string> = {}) {
		const fd = new FormData();
		fd.set("text", "hello");
		for (const [k, v] of Object.entries(fields)) fd.set(k, v);
		return fd;
	}

	function post(env: TestEnv, path: string, headers: Record<string, string> = {}) {
		return call(env, new Request(`${BASE}${path}`, { method: "POST", body: form(), headers }));
	}

	test("rejects an anonymous caller", async () => {
		const res = await post(makeEnv(), "/api/drop/lisa");
		expect(res.status).toBe(401);
		expect(await json(res)).toEqual({ error: "invalid api key" });
	});

	test("accepts a drop token scoped to that inbox", async () => {
		const env = makeEnv();
		await seedDropToken(env, "tok-lisa", "lisa");
		const res = await post(env, "/api/drop/lisa?auth=tok-lisa");
		expect(res.status).toBe(201);
		expect(await json(res)).toMatchObject({ inbox: "lisa" });
	});

	test("rejects a drop token issued for another inbox", async () => {
		const env = makeEnv();
		await seedDropToken(env, "tok-bob", "bob");
		const res = await post(env, "/api/drop/lisa?auth=tok-bob");
		expect(res.status).toBe(401);
	});

	test("accepts a write API key", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_writer", { permissions: "write" });
		const res = await post(env, "/api/drop/lisa", { Authorization: "Bearer ad_writer" });
		expect(res.status).toBe(201);
	});

	test("rejects a read-only API key", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_reader", { permissions: "read" });
		const res = await post(env, "/api/drop/lisa", { Authorization: "Bearer ad_reader" });
		expect(res.status).toBe(403);
		expect(await json(res)).toEqual({ error: "write permission required" });
	});

	test("rejects a write key scoped to another inbox", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_bob", { permissions: "write", inboxScope: "bob" });
		const res = await post(env, "/api/drop/lisa", { Authorization: "Bearer ad_bob" });
		expect(res.status).toBe(403);
		expect(await json(res)).toEqual({ error: "inbox not in scope" });
	});

	test("normalizes the inbox before authorizing and storing", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_lisa", { permissions: "write", inboxScope: "mrgray" });
		const res = await post(env, "/api/drop/Mr.Gray", { Authorization: "Bearer ad_lisa" });
		expect(res.status).toBe(201);
		expect(await json(res)).toMatchObject({ inbox: "mrgray" });
	});

	test("rejects a syntactically invalid inbox name with a 400", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_writer", { permissions: "write" });
		const res = await post(env, "/api/drop/9nope", { Authorization: "Bearer ad_writer" });
		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: expect.stringContaining("invalid inbox name"),
		});
	});

	test("errors carry the browser CORS headers", async () => {
		const res = await post(makeEnv(), "/api/drop/lisa");
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(`https://${TEST_DOMAIN}`);
	});

	test("GET on the drop path is not a route", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_writer", { permissions: "write" });
		const res = await get(env, "/api/drop/lisa", { Authorization: "Bearer ad_writer" });
		expect(res.status).toBe(404);
	});

	test("a nested path under /api/drop is not a route", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_writer", { permissions: "write" });
		const res = await post(env, "/api/drop/lisa/extra", { Authorization: "Bearer ad_writer" });
		expect(res.status).toBe(404);
	});
});

describe("presigned upload routes", () => {
	test("POST /api/upload/presign/:name returns a signed PUT for the drop's key", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_writer", { permissions: "write" });
		const res = await send(
			env,
			"POST",
			"/api/upload/presign/lisa",
			{ Authorization: "Bearer ad_writer" },
			{ fileName: "Report Final.pdf" },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { dropId: string; objectKey: string; uploadUrl: string };
		expect(body.objectKey).toBe(`drops/lisa/${body.dropId}/uploads/report-final.pdf`);
		expect(body.uploadUrl).toContain("X-Amz-Signature");
	});

	test("POST /api/upload/presign/:name rejects an anonymous caller", async () => {
		const res = await send(makeEnv(), "POST", "/api/upload/presign/lisa", {}, { fileName: "a" });
		expect(res.status).toBe(401);
	});

	test("POST /api/upload/multipart/:name inits the upload and presigns each part", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_writer", { permissions: "write" });
		globalThis.fetch = (async () =>
			new Response(
				"<InitiateMultipartUploadResult><UploadId>up-42</UploadId></InitiateMultipartUploadResult>",
			)) as unknown as typeof fetch;

		const res = await send(
			env,
			"POST",
			"/api/upload/multipart/lisa",
			{ Authorization: "Bearer ad_writer" },
			{ fileName: "big.zip", fileSize: 60 * 1024 * 1024 },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { uploadId: string; parts: { partNumber: number }[] };
		expect(body.uploadId).toBe("up-42");
		expect(body.parts).toHaveLength(2);
	});

	test("POST /api/upload/multipart/:name rejects a read-only key", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_reader", { permissions: "read" });
		const res = await send(
			env,
			"POST",
			"/api/upload/multipart/lisa",
			{ Authorization: "Bearer ad_reader" },
			{ fileName: "big.zip", fileSize: 1 },
		);
		expect(res.status).toBe(403);
	});
});

describe("upload finalize routes", () => {
	// The response shapes here changed in phase 5 and the SPA depends on them.
	// The 404 for an unknown drop id comes from the ROUTER's own row lookup, not
	// from handleConfirm -- which is exactly the thing a dispatch rewrite can
	// drop on the floor without any test noticing.
	test("confirm answers 200 with alreadyCompleted false the first time", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_writer", { permissions: "write" });
		await seedPendingDrop(env, { id: "drop-a", inbox: "lisa" });
		const res = await send(
			env,
			"POST",
			"/api/upload/confirm",
			{ Authorization: "Bearer ad_writer" },
			{ dropId: "drop-a" },
		);
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual({
			confirmed: true,
			dropId: "drop-a",
			alreadyCompleted: false,
		});
	});

	test("confirm is idempotent: the second call is 200 with alreadyCompleted true", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_writer", { permissions: "write" });
		await seedPendingDrop(env, { id: "drop-b", inbox: "lisa" });
		const auth = { Authorization: "Bearer ad_writer" };
		await send(env, "POST", "/api/upload/confirm", auth, { dropId: "drop-b" });
		const res = await send(env, "POST", "/api/upload/confirm", auth, { dropId: "drop-b" });
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual({
			confirmed: true,
			dropId: "drop-b",
			alreadyCompleted: true,
		});
	});

	test("an unknown drop id is a 404 from the router's row lookup", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_writer", { permissions: "write" });
		const res = await send(
			env,
			"POST",
			"/api/upload/confirm",
			{ Authorization: "Bearer ad_writer" },
			{ dropId: "ghost" },
		);
		expect(res.status).toBe(404);
		expect(await json(res)).toEqual({ error: "drop not found" });
	});

	test("a missing dropId is a 400 before any auth work", async () => {
		const res = await send(makeEnv(), "POST", "/api/upload/confirm", {}, {});
		expect(res.status).toBe(400);
		expect(await json(res)).toEqual({ error: "dropId required" });
	});

	test("a body that is not JSON is a 400", async () => {
		const res = await call(
			makeEnv(),
			new Request(`${BASE}/api/upload/confirm`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{oops",
			}),
		);
		expect(res.status).toBe(400);
		expect(await json(res)).toEqual({ error: "invalid JSON body" });
	});

	test("complete requires an uploadId", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_writer", { permissions: "write" });
		await seedPendingDrop(env, { id: "drop-c", inbox: "lisa" });
		const res = await send(
			env,
			"POST",
			"/api/upload/complete",
			{ Authorization: "Bearer ad_writer" },
			{ dropId: "drop-c" },
		);
		expect(res.status).toBe(400);
		expect(await json(res)).toEqual({ error: "uploadId required" });
	});

	test("complete round-trips R2's escaped ETags into the completion body", async () => {
		// R2 returns ETags XML-escaped (`&quot;abc&quot;`). The completion body has
		// to carry the SAME etag back. It goes out with literal quotes rather than
		// `&quot;` -- both parse to the same string, and a quote needs no escaping
		// in element content -- so this asserts the decoded value, sorted by part
		// number, which is what R2 actually reads.
		const env = makeEnv();
		await seedApiKey(env, "ad_writer", { permissions: "write" });
		await seedPendingDrop(env, { id: "drop-mp", inbox: "lisa", fileName: "big.zip" });

		let sentBody = "";
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const method = (
				init?.method ?? (input instanceof Request ? input.method : "GET")
			).toUpperCase();
			if (method === "GET") {
				return new Response(
					`<?xml version="1.0" encoding="UTF-8"?>
					<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
						<Part><PartNumber>2</PartNumber><ETag>&quot;second&quot;</ETag><Size>5</Size></Part>
						<Part><PartNumber>1</PartNumber><ETag>&quot;first&quot;</ETag><Size>5</Size></Part>
					</ListPartsResult>`,
				);
			}
			// aws4fetch signs into a Request, so the body is on it, not on `init`.
			sentBody = input instanceof Request ? await input.clone().text() : String(init?.body ?? "");
			return new Response("<CompleteMultipartUploadResult/>");
		}) as unknown as typeof fetch;

		const res = await send(
			env,
			"POST",
			"/api/upload/complete",
			{ Authorization: "Bearer ad_writer" },
			{ dropId: "drop-mp", uploadId: "up-1" },
		);

		expect(res.status).toBe(200);
		expect(sentBody).toBe(
			"<CompleteMultipartUpload>" +
				'<Part><PartNumber>1</PartNumber><ETag>"first"</ETag></Part>' +
				'<Part><PartNumber>2</PartNumber><ETag>"second"</ETag></Part>' +
				"</CompleteMultipartUpload>",
		);
	});

	test("complete and confirm are POST-only", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_writer", { permissions: "write" });
		for (const path of ["/api/upload/complete", "/api/upload/confirm"]) {
			const res = await get(env, path, { Authorization: "Bearer ad_writer" });
			expect(res.status).toBe(404);
		}
	});

	test("finalize responses carry the browser CORS headers", async () => {
		const res = await send(makeEnv(), "POST", "/api/upload/confirm", {}, {});
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(`https://${TEST_DOMAIN}`);
	});
});

describe("routes behind a plain API key", () => {
	test("an invalid key is a 401 before any route matching", async () => {
		const res = await get(makeEnv(), "/api/inbox/lisa", { Authorization: "Bearer nope" });
		expect(res.status).toBe(401);
		expect(await json(res)).toEqual({ error: "invalid api key" });
	});

	test("a completely unknown /api path is a 404 for a valid key", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_reader", { permissions: "read" });
		const res = await get(env, "/api/nope", { Authorization: "Bearer ad_reader" });
		expect(res.status).toBe(404);
		expect(await json(res)).toEqual({ error: "not found" });
	});

	test("GET /api/inbox/:name lists that box's drops", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_reader", { permissions: "read" });
		await seedPendingDrop(env, { id: "d1", inbox: "lisa", status: "completed" });
		await seedPendingDrop(env, { id: "d2", inbox: "bob", status: "completed" });
		const res = await get(env, "/api/inbox/lisa", { Authorization: "Bearer ad_reader" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { drops: { id: string }[] };
		expect(body.drops.map((d) => d.id)).toEqual(["d1"]);
	});

	test("GET /api/inbox/:name normalizes the box name", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_reader", { permissions: "read" });
		await seedPendingDrop(env, { id: "d1", inbox: "mrgray", status: "completed" });
		const res = await get(env, "/api/inbox/Mr.Gray", { Authorization: "Bearer ad_reader" });
		expect(res.status).toBe(200);
		expect((await res.json()) as { count: number }).toMatchObject({ count: 1 });
	});

	test("GET /api/inbox/:name/latest reaches the sub-path handler", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_reader", { permissions: "read" });
		const empty = await get(env, "/api/inbox/lisa/latest", { Authorization: "Bearer ad_reader" });
		expect(empty.status).toBe(404);
		expect(await json(empty)).toEqual({ error: "no drops" });

		await seedPendingDrop(env, { id: "d1", inbox: "lisa", status: "completed" });
		const res = await get(env, "/api/inbox/lisa/latest", { Authorization: "Bearer ad_reader" });
		expect(res.status).toBe(200);
		expect((await res.json()) as { id: string }).toMatchObject({ id: "d1" });
	});

	test("GET /api/inbox/:name/:dropId reaches the sub-path handler", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_reader", { permissions: "read" });
		await seedPendingDrop(env, { id: "d1", inbox: "lisa", status: "completed" });
		const res = await get(env, "/api/inbox/lisa/d1", { Authorization: "Bearer ad_reader" });
		expect(res.status).toBe(200);
		expect((await res.json()) as { id: string }).toMatchObject({ id: "d1" });
	});

	test("a read key scoped to another box cannot read this one", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_bob", { permissions: "read", inboxScope: "bob" });
		const res = await get(env, "/api/inbox/lisa", { Authorization: "Bearer ad_bob" });
		expect(res.status).toBe(403);
		expect(await json(res)).toEqual({ error: "inbox not in scope" });
	});

	test("POST /api/inbox/:name is not a route", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_reader", { permissions: "read" });
		const res = await send(env, "POST", "/api/inbox/lisa", { Authorization: "Bearer ad_reader" });
		expect(res.status).toBe(404);
	});
});

describe("static hosting routes", () => {
	async function writerEnv(objects: Record<string, string> = {}) {
		const env = makeEnv({ BUCKET: makeBucket(objects) });
		await seedApiKey(env, "ad_writer", { permissions: "write" });
		await seedApiKey(env, "ad_reader", { permissions: "read" });
		return env;
	}
	const WRITER = { Authorization: "Bearer ad_writer" };
	const READER = { Authorization: "Bearer ad_reader" };

	test("POST /api/host/presign/:box signs into the site prefix", async () => {
		const env = await writerEnv();
		const res = await send(env, "POST", "/api/host/presign/lisa", WRITER, {
			site: "marketing",
			path: "index.html",
		});
		expect(res.status).toBe(200);
		expect((await res.json()) as { key: string }).toMatchObject({
			key: "sites/lisa/marketing/index.html",
		});
	});

	test("POST /api/host/presign/:box needs write permission", async () => {
		const env = await writerEnv();
		const res = await send(env, "POST", "/api/host/presign/lisa", READER, {
			site: "marketing",
			path: "index.html",
		});
		expect(res.status).toBe(403);
		expect(await json(res)).toEqual({ error: "write permission required" });
	});

	test("POST /api/host/presign/:box respects inbox scope", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_bob", { permissions: "write", inboxScope: "bob" });
		const res = await send(
			env,
			"POST",
			"/api/host/presign/lisa",
			{ Authorization: "Bearer ad_bob" },
			{ site: "marketing", path: "index.html" },
		);
		expect(res.status).toBe(403);
		expect(await json(res)).toEqual({ error: "inbox not in scope" });
	});

	test("POST /api/host/finalize/:box registers the site", async () => {
		const env = await writerEnv({ "sites/lisa/marketing/index.html": "<html></html>" });
		const res = await send(env, "POST", "/api/host/finalize/lisa", WRITER, { site: "marketing" });
		expect(res.status).toBe(200);
		expect((await res.json()) as { site: string; fileCount: number }).toMatchObject({
			site: "marketing",
			fileCount: 1,
		});
	});

	test("GET /api/host/sites/:box lists sites and needs only scope, not write", async () => {
		const env = await writerEnv();
		const res = await get(env, "/api/host/sites/lisa", READER);
		expect(res.status).toBe(200);
		expect(await json(res)).toMatchObject({ count: 0, sites: [] });
	});

	test("GET /api/host/sites/:box respects inbox scope", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_bob", { permissions: "read", inboxScope: "bob" });
		const res = await get(env, "/api/host/sites/lisa", { Authorization: "Bearer ad_bob" });
		expect(res.status).toBe(403);
	});

	test("DELETE /api/host/sites/:box/:site carries the site name through", async () => {
		const env = await writerEnv({
			"sites/lisa/marketing/index.html": "x",
			"sites/lisa/other/index.html": "y",
		});
		const res = await send(env, "DELETE", "/api/host/sites/lisa/marketing", WRITER);
		expect(res.status).toBe(200);
		expect((await res.json()) as { site: string; deleted: number }).toMatchObject({
			site: "marketing",
			deleted: 1,
		});
		// The other site is untouched -- the second path segment really reached the handler.
		expect((env.BUCKET as ReturnType<typeof makeBucket>).deletes).toEqual([
			"sites/lisa/marketing/index.html",
		]);
	});

	test("DELETE /api/host/sites/:box/:site needs write permission", async () => {
		const env = await writerEnv();
		const res = await send(env, "DELETE", "/api/host/sites/lisa/marketing", READER);
		expect(res.status).toBe(403);
	});

	test("DELETE on the site LIST path is not a route", async () => {
		const env = await writerEnv();
		const res = await send(env, "DELETE", "/api/host/sites/lisa", WRITER);
		expect(res.status).toBe(404);
	});
});

describe("outbound mail routes", () => {
	const WRITER = { Authorization: "Bearer ad_writer" };

	async function mailEnv() {
		const env = makeEnv({ EMAIL: makeEmail() as unknown as Env["EMAIL"] });
		await seedApiKey(env, "ad_writer", { permissions: "write" });
		await seedApiKey(env, "ad_reader", { permissions: "read" });
		return env;
	}

	test("POST /api/send/:name sends and needs write permission", async () => {
		const env = await mailEnv();
		const res = await send(env, "POST", "/api/send/lisa", WRITER, {
			to: "bob@example.com",
			subject: "Hi",
			text: "Hello",
		});
		expect(res.status).toBe(200);
		expect(await json(res)).toHaveProperty("messageId");
	});

	test("POST /api/send/:name rejects a read key", async () => {
		const env = await mailEnv();
		const res = await send(
			env,
			"POST",
			"/api/send/lisa",
			{ Authorization: "Bearer ad_reader" },
			{ to: "bob@example.com", subject: "Hi", text: "Hello" },
		);
		expect(res.status).toBe(403);
	});

	test("POST /api/send/presign/:name is matched before /api/send/:name", async () => {
		const env = await mailEnv();
		const res = await send(env, "POST", "/api/send/presign/lisa", WRITER, {
			fileName: "big.zip",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { r2Key: string; uploadUrl: string };
		expect(body.r2Key).toStartWith("outbound/temp/lisa/");
		expect(body.uploadUrl).toContain("X-Amz-Signature");
	});

	test("POST /api/compose/:name renders a preview rather than sending", async () => {
		const env = await mailEnv();
		const res = await send(env, "POST", "/api/compose/lisa", WRITER, {
			to: "bob@example.com",
			subject: "Hi",
			text: "Hello",
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("message/rfc822");
		expect(await res.text()).toContain("Subject: Hi");
	});

	test("POST /api/compose/:name rejects a read key", async () => {
		const env = await mailEnv();
		const res = await send(
			env,
			"POST",
			"/api/compose/lisa",
			{ Authorization: "Bearer ad_reader" },
			{ to: "bob@example.com", subject: "Hi", text: "Hello" },
		);
		expect(res.status).toBe(403);
	});

	test("the mail routes enforce inbox scope like every other write path", async () => {
		// This assertion was inverted in the commit before the fix: it pinned the
		// shipped behavior, where a key scoped to `bob` could send as any box.
		// Full coverage lives in test/send-scope.test.ts.
		const env = await mailEnv();
		await seedApiKey(env, "ad_bob", { permissions: "write", inboxScope: "bob" });
		const auth = { Authorization: "Bearer ad_bob" };

		expect(
			(
				await send(env, "POST", "/api/send/lisa", auth, {
					to: "x@example.com",
					subject: "Hi",
					text: "Hello",
				})
			).status,
		).toBe(403);
		expect(
			(await send(env, "POST", "/api/send/presign/lisa", auth, { fileName: "a.zip" })).status,
		).toBe(403);
		expect(
			(
				await send(env, "POST", "/api/compose/lisa", auth, {
					to: "x@example.com",
					subject: "Hi",
					text: "Hello",
				})
			).status,
		).toBe(403);
	});

	test("GET /api/send/:name is not a route", async () => {
		const env = await mailEnv();
		expect((await get(env, "/api/send/lisa", WRITER)).status).toBe(404);
	});
});
