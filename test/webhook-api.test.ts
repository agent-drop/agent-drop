/**
 * The webhook API's dispatch contract: receiver CRUD and the read side of the
 * queue, driven through the real router so the gates are exercised, not mocked.
 *
 * The split being pinned here is the point of the design. A receiver is
 * configuration and holds a provider's secret, so its CRUD sits in the first
 * tier behind the admin credential. The queue is data an agent consumes, so it
 * sits in the second tier behind an ordinary scoped API key -- and every read
 * filters by the inbox the gate approved, never by id alone.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { handleAPI } from "../src/api/router";
import { serveWebhook } from "../src/lib/webhook-receive";
import {
	makeBucket,
	makeCtx,
	makeEnv,
	seedApiKey,
	seedReceiver,
	TEST_ADMIN_KEY,
	TEST_DOMAIN,
	type TestEnv,
} from "./helpers/env";

const BASE = `https://${TEST_DOMAIN}`;
const ADMIN = { Authorization: `Bearer ${TEST_ADMIN_KEY}` };
const KEY = "ad_reader_key";
const READER = { Authorization: `Bearer ${KEY}` };

let env: TestEnv;
let objects: Record<string, string | Uint8Array>;

beforeEach(async () => {
	objects = {};
	env = makeEnv({ BUCKET: makeBucket(objects) });
	await seedApiKey(env, KEY, { name: "reader", permissions: "read" });
});

function call(request: Request) {
	return handleAPI(request, env, new URL(request.url), makeCtx());
}

function get(path: string, headers: Record<string, string> = {}) {
	return call(new Request(`${BASE}${path}`, { headers }));
}

function send(method: string, path: string, headers: Record<string, string>, body?: unknown) {
	return call(
		new Request(`${BASE}${path}`, {
			method,
			headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
}

/** Push a real request through the public endpoint, so events look genuine. */
async function deliver(
	inbox: string,
	slug: string,
	body: string,
	headers: Record<string, string> = {},
) {
	const url = `${BASE}/h/${inbox}/${slug}`;
	const res = await serveWebhook(
		new Request(url, { method: "POST", headers, body }),
		env,
		new URL(url),
		makeCtx(),
	);
	return (await res.json()) as { id: string };
}

describe("receiver CRUD", () => {
	test("needs the admin credential, not an API key", async () => {
		expect((await get("/api/hooks/receivers")).status).toBe(403);
		expect((await get("/api/hooks/receivers", READER)).status).toBe(403);
		expect((await get("/api/hooks/receivers", ADMIN)).status).toBe(200);
	});

	test("appends an unguessable suffix unless an exact slug is given", async () => {
		const created = await send("POST", "/api/hooks/receivers", ADMIN, {
			inbox: "lisa",
			name: "stripe-prod",
		});
		const body = (await created.json()) as { slug: string; url: string };

		expect(created.status).toBe(201);
		// For a receiver without a signature the URL IS the credential, so a clean
		// guessable slug would hand it away.
		expect(body.slug).toMatch(/^stripe-prod-[0-9a-hjkmnp-tv-z]{26}$/);
		expect(body.url).toBe(`https://${TEST_DOMAIN}/h/lisa/${body.slug}`);
	});

	test("an explicit slug is used verbatim", async () => {
		const res = await send("POST", "/api/hooks/receivers", ADMIN, {
			inbox: "lisa",
			slug: "Meta_Hook",
		});
		expect(((await res.json()) as { slug: string }).slug).toBe("meta-hook");
	});

	test("the secret goes in and never comes back out", async () => {
		const created = await send("POST", "/api/hooks/receivers", ADMIN, {
			inbox: "lisa",
			slug: "s3cret",
			authConfig: { secret: "whsec_do_not_leak" },
		});
		const body = (await created.json()) as Record<string, unknown>;

		expect(body.secret_set).toBe(true);
		expect(JSON.stringify(body)).not.toContain("whsec_do_not_leak");
		expect(body.auth_config).toBeUndefined();
		// It really is stored -- phase 2's verifier reads it from here.
		const row = env.DB.raw.query("SELECT auth_config FROM webhook_receivers").get() as {
			auth_config: string;
		};
		expect(JSON.parse(row.auth_config)).toEqual({ secret: "whsec_do_not_leak" });
	});

	test("refuses a mode this build cannot honour", async () => {
		// Registering a mode nothing verifies would let an operator believe a
		// signature is being checked when it is not. The list is derived from the
		// verifier's own dispatch table, so this is the answer for anything the
		// verifier has genuinely never heard of -- not a hand-maintained denylist.
		const res = await send("POST", "/api/hooks/receivers", ADMIN, {
			inbox: "lisa",
			slug: "st",
			authMode: "someday-mode",
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("not implemented yet");
	});

	test("accepts every mode the verifier actually implements", async () => {
		// The other half of the same guarantee: a preset that exists in the verifier
		// but not in the CRUD's list would be dead code nobody could reach.
		for (const mode of ["stripe", "github", "standard", "slack", "shopify", "hmac", "digest"]) {
			const res = await send("POST", "/api/hooks/receivers", ADMIN, {
				inbox: "lisa",
				slug: `hook-${mode}`,
				authMode: mode,
				authConfig: { secret: "s3cr3t", header: "sign" },
			});
			expect(res.status).toBe(201);
		}
	});

	test("accepts every handshake mode the dispatch table implements", async () => {
		for (const mode of ["meta", "slack", "zoom", "echo", "static"]) {
			const res = await send("POST", "/api/hooks/receivers", ADMIN, {
				inbox: "lisa",
				slug: `hs-${mode}`,
				handshakeMode: mode,
				handshakeConfig: { secret: "s3cr3t", when: { method: "GET" } },
			});
			expect(res.status).toBe(201);
		}
	});

	test("refuses a handshake mode nothing answers", async () => {
		const res = await send("POST", "/api/hooks/receivers", ADMIN, {
			inbox: "lisa",
			slug: "hs",
			handshakeMode: "carrier-pigeon",
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("not implemented yet");
	});

	test("refuses a handshake that could not answer if it fired", async () => {
		// A receiver that looks configured, gets pasted into a dashboard, and fails
		// validation with an error only our logs carry. Zoom re-checks every 72
		// hours, so that failure can surface days after the mistake.
		for (const [mode, fragment] of [
			["meta", "verify token"],
			["zoom", "secret token"],
			["static", "`when` predicate"],
		]) {
			const res = await send("POST", "/api/hooks/receivers", ADMIN, {
				inbox: "lisa",
				slug: `bad-${mode}`,
				handshakeMode: mode,
			});
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).toContain(fragment);
		}
	});

	test("a meta receiver gets GET added, because its verification is a GET", async () => {
		// Otherwise the method check 405s before the handshake ever runs, and the
		// operator sees "verification failed" with no hint that a method list did it.
		const res = await send("POST", "/api/hooks/receivers", ADMIN, {
			inbox: "lisa",
			slug: "fb",
			handshakeMode: "meta",
			handshakeConfig: { token: "verify-me" },
		});
		expect(((await res.json()) as { allowed_methods: string }).allowed_methods).toBe("POST,GET");
	});

	test("switching a live receiver to meta widens its methods too", async () => {
		await send("POST", "/api/hooks/receivers", ADMIN, { inbox: "lisa", slug: "fb" });
		const res = await send("PATCH", "/api/hooks/receivers/lisa/fb", ADMIN, {
			handshakeMode: "meta",
			handshakeConfig: { token: "verify-me" },
		});
		expect(((await res.json()) as { allowed_methods: string }).allowed_methods).toBe("POST,GET");
	});

	test("a patch is judged against the row as it will be, not either half alone", async () => {
		await send("POST", "/api/hooks/receivers", ADMIN, {
			inbox: "lisa",
			slug: "zm",
			handshakeMode: "zoom",
			handshakeConfig: { secret: "already-set" },
		});
		// Mode unchanged, config replaced with one that cannot answer.
		const stripped = await send("PATCH", "/api/hooks/receivers/lisa/zm", ADMIN, {
			handshakeConfig: { label: "not a secret" },
		});
		expect(stripped.status).toBe(400);
		// And the other direction: the secret is already on the row, so naming the
		// mode again is fine on its own.
		const remode = await send("PATCH", "/api/hooks/receivers/lisa/zm", ADMIN, {
			handshakeMode: "zoom",
		});
		expect(remode.status).toBe(200);
	});

	test("the handshake secret goes in and never comes back out", async () => {
		const created = await send("POST", "/api/hooks/receivers", ADMIN, {
			inbox: "lisa",
			slug: "zm",
			handshakeMode: "zoom",
			handshakeConfig: { secret: "zoom_do_not_leak" },
		});
		const body = (await created.json()) as Record<string, unknown>;

		expect(body.handshake_secret_set).toBe(true);
		expect(JSON.stringify(body)).not.toContain("zoom_do_not_leak");
	});

	test("refuses an unknown extraction preset", async () => {
		const res = await send("POST", "/api/hooks/receivers", ADMIN, {
			inbox: "lisa",
			slug: "x",
			preset: "hotmail",
		});
		expect(res.status).toBe(400);
	});

	test("the same inbox and slug twice is a 409", async () => {
		await send("POST", "/api/hooks/receivers", ADMIN, { inbox: "lisa", slug: "dupe" });
		const second = await send("POST", "/api/hooks/receivers", ADMIN, {
			inbox: "lisa",
			slug: "dupe",
		});
		expect(second.status).toBe(409);
	});

	test("reads by id, by box/slug, and lists by box", async () => {
		const id = await seedReceiver(env, { inbox: "lisa", slug: "one" });
		await seedReceiver(env, { inbox: "bob", slug: "two" });

		expect(((await (await get(`/api/hooks/receivers/${id}`, ADMIN)).json()) as any).slug).toBe(
			"one",
		);
		expect(((await (await get("/api/hooks/receivers/lisa/one", ADMIN)).json()) as any).id).toBe(id);
		expect(
			((await (await get("/api/hooks/receivers/lisa", ADMIN)).json()) as any).receivers,
		).toHaveLength(1);
		expect(
			((await (await get("/api/hooks/receivers", ADMIN)).json()) as any).receivers,
		).toHaveLength(2);
	});

	test("patches config and rotates the secret", async () => {
		const id = await seedReceiver(env, { inbox: "lisa", slug: "p", authConfig: { secret: "old" } });

		await send("PATCH", `/api/hooks/receivers/${id}`, ADMIN, {
			enabled: false,
			label: "paused",
			retentionDays: 30,
			authConfig: { secret: "new" },
		});

		const row = env.DB.raw.query("SELECT * FROM webhook_receivers WHERE id = ?").get(id) as any;
		expect(row.enabled).toBe(0);
		expect(row.label).toBe("paused");
		expect(row.retention_days).toBe(30);
		// Rotation replaces the blob: the old secret stops working immediately.
		expect(JSON.parse(row.auth_config)).toEqual({ secret: "new" });
	});

	test("an empty patch is a 400, not a silent no-op", async () => {
		const id = await seedReceiver(env, { inbox: "lisa", slug: "p" });
		expect((await send("PATCH", `/api/hooks/receivers/${id}`, ADMIN, {})).status).toBe(400);
	});

	test("delete keeps the events; --purge destroys them and their R2 bodies", async () => {
		const id = await seedReceiver(env, { inbox: "lisa", slug: "gone" });
		await deliver("lisa", "gone", " binary-ish");
		const key = (env.DB.raw.query("SELECT body_r2_key FROM webhook_events").get() as any)
			.body_r2_key;

		await send("DELETE", `/api/hooks/receivers/${id}`, ADMIN);
		// The events are an audit trail and reference receiver_id, not the slug.
		expect(env.DB.raw.query("SELECT * FROM webhook_events").all()).toHaveLength(1);

		const receiverAgain = await seedReceiver(env, { inbox: "lisa", slug: "gone", id });
		const purge = await send("DELETE", `/api/hooks/receivers/${receiverAgain}?purge=1`, ADMIN);

		expect(((await purge.json()) as any).purged).toBe(1);
		expect(env.DB.raw.query("SELECT * FROM webhook_events").all()).toHaveLength(0);
		expect(objects[key]).toBeUndefined();
	});
});

describe("queue reads", () => {
	beforeEach(async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "gh", preset: "github" });
		await seedReceiver(env, { inbox: "bob", slug: "other" });
	});

	test("need a key, and honour the key's inbox scope", async () => {
		expect((await get("/api/hooks/queue/lisa")).status).toBe(401);
		expect((await get("/api/hooks/queue/lisa", READER)).status).toBe(200);

		await seedApiKey(env, "ad_scoped", { name: "scoped", permissions: "read", inboxScope: "bob" });
		const scoped = { Authorization: "Bearer ad_scoped" };
		expect((await get("/api/hooks/queue/bob", scoped)).status).toBe(200);
		expect((await get("/api/hooks/queue/lisa", scoped)).status).toBe(403);
	});

	test("lists newest first, and filters by receiver, status, event and routing key", async () => {
		await deliver("lisa", "gh", '{"n":1}', { "X-GitHub-Event": "push" });
		await deliver("lisa", "gh", '{"n":2}', { "X-GitHub-Event": "issues" });
		await deliver("bob", "other", '{"n":3}');

		const all = (await (await get("/api/hooks/queue/lisa", READER)).json()) as any;
		expect(all.count).toBe(2);
		// Another box's events are not reachable through this box's path.
		expect(all.events.every((e: any) => e.inbox === "lisa")).toBe(true);

		const filtered = (await (await get("/api/hooks/queue/lisa?event=push", READER)).json()) as any;
		expect(filtered.count).toBe(1);
		expect(filtered.events[0].event_type).toBe("push");

		const bySlug = (await (await get("/api/hooks/queue/lisa?receiver=gh", READER)).json()) as any;
		expect(bySlug.count).toBe(2);
		expect(
			((await (await get("/api/hooks/queue/lisa?status=acked", READER)).json()) as any).count,
		).toBe(0);
	});

	test("?since= walks forward from a cursor in arrival order", async () => {
		const first = await deliver("lisa", "gh", '{"n":1}', { "X-GitHub-Delivery": "d1" });
		// A millisecond apart on purpose. Ids are ULIDs, so they order by ARRIVAL
		// MILLISECOND; inside one millisecond the random tail decides, and two
		// events that landed in the same millisecond may sort either way.
		await new Promise((resolve) => setTimeout(resolve, 2));
		await deliver("lisa", "gh", '{"n":2}', { "X-GitHub-Delivery": "d2" });

		const after = (await (
			await get(`/api/hooks/queue/lisa?since=${first.id}`, READER)
		).json()) as any;

		expect(after.count).toBe(1);
		expect(after.events[0].id > first.id).toBe(true);
	});

	test("the list carries no bodies -- that is what peek and body are for", async () => {
		await deliver("lisa", "gh", '{"secret":"in the body"}');
		const listed = (await (await get("/api/hooks/queue/lisa", READER)).json()) as any;
		expect(listed.events[0].body_text).toBeUndefined();
		expect(listed.events[0].body_sha256).toBeTruthy();
	});

	test("peek returns headers and body, and mutates nothing at all", async () => {
		const sent = await deliver("lisa", "gh", '{"n":1}', { "X-GitHub-Event": "push" });
		const before = env.DB.raw.query("SELECT * FROM webhook_events WHERE id = ?").get(sent.id);

		const peeked = (await (await send("POST", "/api/hooks/queue/lisa/peek", READER)).json()) as any;
		const one = (await (await get(`/api/hooks/queue/lisa/${sent.id}`, READER)).json()) as any;

		expect(peeked.events[0].headers["x-github-event"]).toBe("push");
		expect(one.body).toBe('{"n":1}');
		expect(one.body_available).toBe(true);
		// You can peek the same message a hundred times and the queue is exactly as
		// it was -- the whole point when you are debugging a provider at 2am.
		const after = env.DB.raw.query("SELECT * FROM webhook_events WHERE id = ?").get(sent.id);
		expect(after).toEqual(before);
	});

	test("peeking another box's event through this box's path is a 404", async () => {
		const other = await deliver("bob", "other", "{}");
		expect((await get(`/api/hooks/queue/lisa/${other.id}`, READER)).status).toBe(404);
	});

	test("the body endpoint returns the exact bytes under the original type", async () => {
		const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);
		const url = `${BASE}/h/lisa/gh`;
		const posted = await serveWebhook(
			new Request(url, {
				method: "POST",
				headers: { "Content-Type": "application/octet-stream" },
				body: bytes,
			}),
			env,
			new URL(url),
			makeCtx(),
		);
		const { id } = (await posted.json()) as { id: string };

		const res = await get(`/api/hooks/queue/lisa/${id}/body`, READER);

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
		// This is the endpoint the byte-fidelity promise is made to: a consumer
		// holding the provider's secret verifies its signature against these bytes.
		expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(bytes));
		expect(res.headers.get("X-Body-Sha256")).toHaveLength(64);
	});

	test("an inline body comes back through the body endpoint too", async () => {
		const sent = await deliver("lisa", "gh", '{"inline":true}', {
			"Content-Type": "application/json",
		});

		const res = await get(`/api/hooks/queue/lisa/${sent.id}/body`, READER);

		expect(await res.text()).toBe('{"inline":true}');
		expect(res.headers.get("Content-Type")).toBe("application/json");
	});

	test("an unknown event id is a 404, not an empty 200", async () => {
		expect((await get("/api/hooks/queue/lisa/nope", READER)).status).toBe(404);
		expect((await get("/api/hooks/queue/lisa/nope/body", READER)).status).toBe(404);
	});
});
