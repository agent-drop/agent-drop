/**
 * The rest of the message vocabulary: put, delete, stats, rotate, and the
 * `--delete-on-success` loop the CLI drives.
 *
 * Same discipline as the lease suite -- the row, and the R2 map, are the fact.
 * "deleted: 3" from a handler that left an object behind in the bucket is exactly
 * the kind of quiet lie an assertion against the response body would miss.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { handleAPI } from "../src/api/router";
import { serveWebhook } from "../src/lib/webhook-receive";
import { emitEvents } from "../tools/lib/queue-emit";
import {
	makeBucket,
	makeCtx,
	makeEnv,
	seedApiKey,
	seedReceiver,
	TEST_ADMIN_KEY,
	type TestEnv,
} from "./helpers/env";
import type { WebhookEvent } from "../src/types";

const BASE = "https://drop.test";
const ADMIN = { Authorization: `Bearer ${TEST_ADMIN_KEY}` };
const WRITER = { Authorization: "Bearer ad_writer_key" };
const READER = { Authorization: "Bearer ad_reader_key" };

let env: TestEnv;
let objects: Record<string, string | Uint8Array>;

beforeEach(async () => {
	objects = {};
	env = makeEnv({ BUCKET: makeBucket(objects) });
	await seedApiKey(env, "ad_writer_key", { name: "writer", permissions: "write" });
	await seedApiKey(env, "ad_reader_key", { name: "reader", permissions: "read" });
	await seedReceiver(env, { inbox: "lisa", slug: "gh", preset: "github" });
});

function call(request: Request) {
	return handleAPI(request, env, new URL(request.url), makeCtx());
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

function get(path: string, headers: Record<string, string> = {}) {
	return call(new Request(`${BASE}${path}`, { headers }));
}

async function json<T>(res: Response): Promise<T> {
	return (await res.json()) as T;
}

async function deliver(inbox: string, slug: string, body: string | Uint8Array, headers = {}) {
	const url = `${BASE}/h/${inbox}/${slug}`;
	const res = await serveWebhook(
		new Request(url, { method: "POST", headers, body }),
		env,
		new URL(url),
		makeCtx(),
	);
	return (await res.json()) as { id: string };
}

async function deliverMany(count: number, inbox = "lisa", slug = "gh"): Promise<string[]> {
	const ids: string[] = [];
	for (let i = 0; i < count; i++) {
		const sent = await deliver(inbox, slug, `{"n":${i}}`, { "X-GitHub-Delivery": `d${i}-${slug}` });
		ids.push(sent.id);
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	return ids;
}

function row(id: string): WebhookEvent | undefined {
	return (
		(env.DB.raw.query("SELECT * FROM webhook_events WHERE id = ?").get(id) as WebhookEvent) ??
		undefined
	);
}

function ids(): string[] {
	return (
		env.DB.raw.query("SELECT id FROM webhook_events ORDER BY id").all() as { id: string }[]
	).map((r) => r.id);
}

describe("queue-put", () => {
	test("lands a message through the same path a real provider would", async () => {
		const res = await json<{ injected: boolean; id: string }>(
			await send("POST", "/api/hooks/queue/lisa/put", WRITER, {
				receiver: "gh",
				body: '{"action":"opened"}',
				headers: { "X-GitHub-Event": "issues", "X-GitHub-Delivery": "put-1" },
			}),
		);

		expect(res.injected).toBe(true);
		const stored = row(res.id) as WebhookEvent;
		// The preset ran, so extraction happened -- which is the point of reusing the
		// receive path instead of writing a friendlier row straight into D1.
		expect(stored.event_type).toBe("issues");
		expect(stored.dedupe_key).toBe("put-1");
		expect(stored.body_text).toBe('{"action":"opened"}');
		expect(stored.status).toBe("queued");
		// And it is immediately leasable, like anything else that arrived.
		const got = await json<{ count: number }>(
			await send("POST", "/api/hooks/queue/lisa/get", WRITER, { limit: 5 }),
		);
		expect(got.count).toBe(1);
	});

	test("inherits BOTH redaction lists, not just the headers", async () => {
		await seedReceiver(env, {
			inbox: "lisa",
			slug: "tok",
			authMode: "query",
			authConfig: { param: "token", secret: "s3cr3t" },
		});

		const res = await json<{ id: string }>(
			await send("POST", "/api/hooks/queue/lisa/put", WRITER, {
				receiver: "tok",
				body: "{}",
				query: { token: "s3cr3t", harmless: "keep-me" },
				headers: { Authorization: "Bearer nope", "X-Custom": "keep-me-too" },
			}),
		);

		const stored = row(res.id) as WebhookEvent;
		const query = JSON.parse(stored.query as string) as Record<string, string>;
		const headers = JSON.parse(stored.headers as string) as Record<string, string>;
		// A shared secret is no less a credential for arriving in a `?token=`, and an
		// injection path that only redacted headers would reopen exactly the hole
		// phase 3 closed.
		expect(query.token).toBe("<redacted>");
		expect(query.harmless).toBe("keep-me");
		expect(headers.authorization).toBe("<redacted>");
		expect(headers["x-custom"]).toBe("keep-me-too");
	});

	test("is verified like a real delivery -- no flag writes a verdict nothing checked", async () => {
		await seedReceiver(env, {
			inbox: "lisa",
			slug: "signed",
			authMode: "digest",
			authConfig: { secret: "123456ABCDEF", header: "sign", template: "{body}/{secret}" },
		});

		const res = await send("POST", "/api/hooks/queue/lisa/put", WRITER, {
			receiver: "signed",
			body: '{"hello":true}',
		});

		expect(res.status).toBe(401);
		const stored = env.DB.raw.query("SELECT status, verified FROM webhook_events").get() as {
			status: string;
			verified: number;
		};
		expect(stored.status).toBe("rejected");
		expect(stored.verified).toBe(0);
	});

	test("carries raw bytes through base64, unchanged", async () => {
		const bytes = new Uint8Array([0x00, 0xff, 0xc3, 0x28, 0x89]);
		const res = await json<{ id: string }>(
			await send("POST", "/api/hooks/queue/lisa/put", WRITER, {
				receiver: "gh",
				bodyBase64: btoa(String.fromCharCode(...bytes)),
				contentType: "application/octet-stream",
			}),
		);

		const back = await get(`/api/hooks/queue/lisa/${res.id}/body`, READER);
		expect(Array.from(new Uint8Array(await back.arrayBuffer()))).toEqual(Array.from(bytes));
		// 0xC3 0x28 is not valid UTF-8, so it never became text.
		expect((row(res.id) as WebhookEvent).body_text).toBeNull();
	});

	test("cannot reach a receiver in another box", async () => {
		await seedReceiver(env, { inbox: "bob", slug: "theirs" });
		const res = await send("POST", "/api/hooks/queue/lisa/put", WRITER, {
			receiver: "theirs",
			body: "{}",
		});
		expect(res.status).toBe(404);
		expect(env.DB.raw.query("SELECT * FROM webhook_events").all()).toHaveLength(0);
	});

	test("needs a write key", async () => {
		expect(
			(await send("POST", "/api/hooks/queue/lisa/put", READER, { receiver: "gh", body: "{}" }))
				.status,
		).toBe(403);
	});
});

describe("queue-delete", () => {
	test("destroys the row and its R2 body", async () => {
		// Not valid UTF-8, so the body lives in R2 rather than inline.
		const sent = await deliver("lisa", "gh", new Uint8Array([0xff, 0xfe, 0x41]));
		const key = (row(sent.id) as WebhookEvent).body_r2_key as string;
		expect(objects[key]).toBeDefined();

		const res = await json<{ deleted: number }>(
			await send("POST", "/api/hooks/queue/lisa/delete", WRITER, { ids: [sent.id] }),
		);

		expect(res.deleted).toBe(1);
		expect(row(sent.id)).toBeUndefined();
		// An orphaned R2 object is invisible and billed forever.
		expect(objects[key]).toBeUndefined();
	});

	test("DELETE on one event destroys exactly that one", async () => {
		const list = await deliverMany(3);
		const res = await send("DELETE", `/api/hooks/queue/lisa/${list[1]}`, WRITER);

		expect(res.status).toBe(200);
		expect(ids()).toEqual([list[0], list[2]].sort());
		expect((await send("DELETE", `/api/hooks/queue/lisa/${list[1]}`, WRITER)).status).toBe(404);
	});

	test("--removed destroys exactly the acked rows and nothing else", async () => {
		const list = await deliverMany(4);
		await send("POST", "/api/hooks/queue/lisa/remove", WRITER, { ids: [list[0], list[2]] });
		await send("POST", "/api/hooks/queue/lisa/get", WRITER, { limit: 1 }); // leases list[1]

		const res = await json<{ deleted: number; ids: string[] }>(
			await send("POST", "/api/hooks/queue/lisa/delete", WRITER, { removed: true }),
		);

		expect(res.ids.sort()).toEqual([list[0], list[2]].sort());
		expect(ids()).toEqual([list[1], list[3]].sort());
		expect(res.deleted).toBe(2);
	});

	test("--before destroys everything older than a cursor, and nothing newer", async () => {
		const list = await deliverMany(4);

		const res = await json<{ ids: string[] }>(
			await send("POST", "/api/hooks/queue/lisa/delete", WRITER, { before: list[2] }),
		);

		// Strictly older: the cursor event itself survives, because "before" is not
		// "up to and including" and a walk that re-reads its own cursor is normal.
		expect(res.ids.sort()).toEqual([list[0], list[1]].sort());
		expect(ids()).toEqual([list[2], list[3]].sort());
	});

	test("refuses to destroy a whole box on a typo", async () => {
		await deliverMany(2);
		const res = await send("POST", "/api/hooks/queue/lisa/delete", WRITER, {});
		expect(res.status).toBe(400);
		expect(ids()).toHaveLength(2);
	});

	test("cannot reach another box's event by id", async () => {
		await seedReceiver(env, { inbox: "bob", slug: "other" });
		const theirs = await deliver("bob", "other", "{}");

		expect(
			(
				await json<{ deleted: number }>(
					await send("POST", "/api/hooks/queue/lisa/delete", WRITER, { ids: [theirs.id] }),
				)
			).deleted,
		).toBe(0);
		expect((await send("DELETE", `/api/hooks/queue/lisa/${theirs.id}`, WRITER)).status).toBe(404);
		expect(row(theirs.id)).toBeDefined();
	});

	test("needs a write key", async () => {
		const [id] = await deliverMany(1);
		expect((await send("POST", "/api/hooks/queue/lisa/delete", READER, { ids: [id] })).status).toBe(
			403,
		);
		expect((await send("DELETE", `/api/hooks/queue/lisa/${id}`, READER)).status).toBe(403);
		expect(row(id)).toBeDefined();
	});
});

describe("queue-stats", () => {
	test("counts by status, bytes and last arrival", async () => {
		const list = await deliverMany(3);
		await send("POST", "/api/hooks/queue/lisa/remove", WRITER, { ids: [list[0]] });
		await send("POST", "/api/hooks/queue/lisa/get", WRITER, { limit: 1, leaseSeconds: 600 });

		const stats = await json<{
			total: number;
			bytes: number;
			by_status: Record<string, number>;
			leased_now: number;
			last_event_at: number;
		}>(await get("/api/hooks/queue/lisa/stats", READER));

		expect(stats.total).toBe(3);
		expect(stats.by_status).toEqual({ acked: 1, leased: 1, queued: 1 });
		expect(stats.bytes).toBe(3 * '{"n":0}'.length);
		expect(stats.leased_now).toBe(1);
		expect(stats.last_event_at).toBe((row(list[2]) as WebhookEvent).created_at);
	});

	test("an expired lease is not counted as held", async () => {
		const [id] = await deliverMany(1);
		await send("POST", "/api/hooks/queue/lisa/get", WRITER, { limit: 1 });
		env.DB.raw.query("UPDATE webhook_events SET leased_until = ? WHERE id = ?").run(1, id);

		const stats = await json<{ leased_now: number; by_status: Record<string, number> }>(
			await get("/api/hooks/queue/lisa/stats", READER),
		);

		// The row still says `leased`, but nobody is holding it -- it is back in the
		// pool, and telling an operator work is in flight would be wrong.
		expect(stats.by_status.leased).toBe(1);
		expect(stats.leased_now).toBe(0);
	});

	test("is a read: a read-only key gets it, and stats is not an event id", async () => {
		expect((await get("/api/hooks/queue/lisa/stats", READER)).status).toBe(200);
		// The `:id` route would happily have answered 404 for "stats" and hidden this.
		expect(
			(await json<{ inbox: string }>(await get("/api/hooks/queue/lisa/stats", READER))).inbox,
		).toBe("lisa");
	});
});

describe("hook-rotate", () => {
	test("changes the slug while every existing message stays reachable", async () => {
		const list = await deliverMany(2, "lisa", "gh");
		const id = (
			env.DB.raw.query("SELECT id FROM webhook_receivers WHERE slug = 'gh'").get() as {
				id: string;
			}
		).id;

		const rotated = await json<{ slug: string; url: string }>(
			await send("POST", `/api/hooks/receivers/${id}/rotate`, ADMIN, {}),
		);

		expect(rotated.slug).not.toBe("gh");
		expect(rotated.url).toBe(`https://drop.test/h/lisa/${rotated.slug}`);
		// Events reference receiver_id, not the slug -- that is the whole reason
		// rotation is cheap -- so nothing stored has moved or gone missing.
		for (const one of list) {
			expect((await get(`/api/hooks/queue/lisa/${one}`, READER)).status).toBe(200);
		}
		const byNew = await json<{ count: number }>(
			await get(`/api/hooks/queue/lisa?receiver=${rotated.slug}`, READER),
		);
		expect(byNew.count).toBe(2);
		// And still by the name they were stored under.
		expect(
			(await json<{ count: number }>(await get("/api/hooks/queue/lisa?receiver=gh", READER))).count,
		).toBe(2);
	});

	test("the new URL takes deliveries and the old one is dead without a grace window", async () => {
		const id = (
			env.DB.raw.query("SELECT id FROM webhook_receivers WHERE slug = 'gh'").get() as {
				id: string;
			}
		).id;
		const rotated = await json<{ slug: string }>(
			await send("POST", `/api/hooks/receivers/${id}/rotate`, ADMIN, {}),
		);

		const fresh = await deliver("lisa", rotated.slug, '{"after":true}');
		expect(row(fresh.id)).toBeDefined();

		const url = `${BASE}/h/lisa/gh`;
		const dead = await serveWebhook(
			new Request(url, { method: "POST", body: "{}" }),
			env,
			new URL(url),
			makeCtx(),
		);
		// No grace means the old URL stops answering immediately, which is what you
		// want when the reason for rotating is that it leaked.
		expect(dead.status).toBe(404);
	});

	test("--grace keeps the old slug answering for the cutover", async () => {
		const id = (
			env.DB.raw.query("SELECT id FROM webhook_receivers WHERE slug = 'gh'").get() as {
				id: string;
			}
		).id;

		const rotated = await json<{ previous_slug: string; previous_slug_expires_at: number }>(
			await send("POST", `/api/hooks/receivers/${id}/rotate`, ADMIN, { graceSeconds: 3600 }),
		);
		expect(rotated.previous_slug).toBe("gh");
		expect(rotated.previous_slug_expires_at).toBeGreaterThan(Date.now());

		// A provider still pushing at the old URL mid-cutover must not be dropped.
		const during = await deliver("lisa", "gh", '{"mid":"cutover"}');
		expect(row(during.id)).toBeDefined();

		env.DB.raw
			.query("UPDATE webhook_receivers SET previous_slug_expires_at = 1 WHERE id = ?")
			.run(id);
		const url = `${BASE}/h/lisa/gh`;
		const after = await serveWebhook(
			new Request(url, { method: "POST", body: "{}" }),
			env,
			new URL(url),
			makeCtx(),
		);
		expect(after.status).toBe(404);
	});

	test("takes an explicit slug, refuses a taken one, and needs admin", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "taken" });
		expect((await send("POST", "/api/hooks/receivers/lisa/gh/rotate", WRITER, {})).status).toBe(
			403,
		);

		const conflict = await send("POST", "/api/hooks/receivers/lisa/gh/rotate", ADMIN, {
			slug: "taken",
		});
		expect(conflict.status).toBe(409);
		expect(
			env.DB.raw.query("SELECT slug FROM webhook_receivers WHERE slug = 'gh'").all(),
		).toHaveLength(1);

		const ok = await json<{ slug: string }>(
			await send("POST", "/api/hooks/receivers/lisa/gh/rotate", ADMIN, { slug: "GH_Prod" }),
		);
		expect(ok.slug).toBe("gh-prod");
	});

	test("keeps the name you chose and only re-rolls the suffix", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "stripe-prod-k7f2q9" });
		const rotated = await json<{ slug: string }>(
			await send("POST", "/api/hooks/receivers/lisa/stripe-prod-k7f2q9/rotate", ADMIN, {}),
		);
		expect(rotated.slug).toMatch(/^stripe-prod-[0-9a-z]{6}$/);
		expect(rotated.slug).not.toBe("stripe-prod-k7f2q9");
	});
});

describe("--delete-on-success", () => {
	test("finishes each event only after it is written out", async () => {
		const written: string[] = [];
		const finished: string[] = [];

		const result = await emitEvents({
			events: ["a", "b", "c"],
			write: (e) => {
				written.push(e);
			},
			finish: async (e) => {
				finished.push(e);
			},
		});

		expect(result.finished).toEqual(["a", "b", "c"]);
		expect(result.remaining).toEqual([]);
		expect(written).toEqual(["a", "b", "c"]);
		expect(finished).toEqual(["a", "b", "c"]);
	});

	test("leaves the un-emitted remainder alone when the output fails partway", async () => {
		const finished: string[] = [];

		const result = await emitEvents({
			events: ["a", "b", "c"],
			write: (e) => {
				if (e === "b") throw new Error("EPIPE");
			},
			finish: async (e) => {
				finished.push(e);
			},
		});

		// The one that failed is NOT finished -- we cannot prove the caller saw it.
		expect(finished).toEqual(["a"]);
		expect(result.finished).toEqual(["a"]);
		expect(result.remaining).toEqual(["b", "c"]);
		expect(String(result.error)).toContain("EPIPE");
	});

	test("the remainder is still leased, not destroyed", async () => {
		const list = await deliverMany(3);
		const leased = await json<{ events: { id: string }[] }>(
			await send("POST", "/api/hooks/queue/lisa/get", WRITER, { limit: 3, leaseSeconds: 600 }),
		);

		const result = await emitEvents({
			events: leased.events,
			write: (e, i) => {
				if (i === 1) throw new Error("disk full");
				expect(e.id).toBeTruthy();
			},
			finish: async (e) => {
				await send("DELETE", `/api/hooks/queue/lisa/${e.id}`, WRITER);
			},
		});

		expect(result.finished).toHaveLength(1);
		expect(row(list[0])).toBeUndefined();
		// A pull that dies halfway must not eat the messages it never handed over:
		// they stay leased, the lease expires, and someone gets another go at them.
		for (const id of [list[1], list[2]]) {
			const r = row(id) as WebhookEvent;
			expect(r.status).toBe("leased");
			expect(r.leased_until).toBeGreaterThan(Date.now());
		}
	});
});
