/**
 * The pull queue's lease semantics, driven through the real router.
 *
 * Every assertion here reads the ROW back with `env.DB.raw.query` rather than
 * trusting what the handler said it did. The handler's own summary is a claim;
 * `status`, `lease_id`, `leased_until` and `lease_count` are the fact, and a
 * queue that reports "leased 3" while leaving four rows leasable is exactly the
 * failure worth catching.
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
	type TestEnv,
} from "./helpers/env";
import type { WebhookEvent } from "../src/types";

const BASE = "https://drop.test";
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
	await seedReceiver(env, { inbox: "bob", slug: "other" });
});

function call(request: Request) {
	return handleAPI(request, env, new URL(request.url), makeCtx());
}

function post(path: string, headers: Record<string, string>, body?: unknown) {
	return call(
		new Request(`${BASE}${path}`, {
			method: "POST",
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

/** A real delivery through the public endpoint, so events look genuine. */
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

/** N deliveries, a millisecond apart so their arrival order is unambiguous. */
async function deliverMany(count: number, inbox = "lisa", slug = "gh"): Promise<string[]> {
	const ids: string[] = [];
	for (let i = 0; i < count; i++) {
		const sent = await deliver(inbox, slug, `{"n":${i}}`, { "X-GitHub-Delivery": `d${i}-${slug}` });
		ids.push(sent.id);
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	return ids;
}

function row(id: string): WebhookEvent {
	return env.DB.raw.query("SELECT * FROM webhook_events WHERE id = ?").get(id) as WebhookEvent;
}

function lease(body: Record<string, unknown> = {}, headers = WRITER) {
	return post("/api/hooks/queue/lisa/get", headers, body);
}

describe("queue-get: leasing", () => {
	test("hands out the oldest first and hides them from the pool", async () => {
		const ids = await deliverMany(3);

		const got = await json<{ events: { id: string }[]; lease_id: string; leased_until: number }>(
			await lease({ limit: 2, leaseSeconds: 60 }),
		);

		expect(got.events.map((e) => e.id)).toEqual([ids[0], ids[1]]);
		expect(got.lease_id).toMatch(/^[0-9a-f-]{36}$/);
		for (const id of [ids[0], ids[1]]) {
			const r = row(id);
			expect(r.status).toBe("leased");
			expect(r.lease_id).toBe(got.lease_id);
			expect(r.leased_until).toBe(got.leased_until);
			expect(r.lease_count).toBe(1);
		}
		expect(row(ids[2]).status).toBe("queued");
	});

	test("two concurrent gets never return the same message", async () => {
		const ids = await deliverMany(4);

		// Both in flight at once. The lease is one UPDATE ... RETURNING precisely so
		// this cannot interleave into a double handout; a read-then-write pair would.
		const [a, b] = await Promise.all([
			json<{ events: { id: string }[] }>(await lease({ limit: 4 })),
			json<{ events: { id: string }[] }>(await lease({ limit: 4 })),
		]);

		const first = a.events.map((e) => e.id);
		const second = b.events.map((e) => e.id);
		expect(first.filter((id) => second.includes(id))).toEqual([]);
		expect([...first, ...second].sort()).toEqual([...ids].sort());
		// Every row handed out exactly once, so nobody's lease_count says twice.
		for (const id of ids) expect(row(id).lease_count).toBe(1);
	});

	test("an expired lease is re-served exactly once, and bumps lease_count", async () => {
		const [id] = await deliverMany(1);
		const held = await json<{ lease_id: string }>(await lease({ limit: 1, leaseSeconds: 60 }));

		// Nothing is scheduled to notice an expiry: the lease SELECT's OR is what
		// puts a crashed consumer's work back in the pool.
		expect((await json<{ count: number }>(await lease({ limit: 5 }))).count).toBe(0);
		env.DB.raw.query("UPDATE webhook_events SET leased_until = ? WHERE id = ?").run(1, id);

		const again = await json<{ events: { id: string }[]; lease_id: string }>(
			await lease({ limit: 5 }),
		);
		expect(again.events.map((e) => e.id)).toEqual([id]);
		expect(again.lease_id).not.toBe(held.lease_id);
		expect(row(id).lease_count).toBe(2);
		// And once re-served it is hidden again, not handed out a third time.
		expect((await json<{ count: number }>(await lease({ limit: 5 }))).count).toBe(0);
	});

	test("never leases a handshake row", async () => {
		await seedReceiver(env, {
			inbox: "lisa",
			slug: "zoom",
			handshakeMode: "zoom",
			handshakeConfig: { secret: "zoomSecret123" },
		});
		await deliver(
			"lisa",
			"zoom",
			JSON.stringify({
				event: "endpoint.url_validation",
				payload: { plainToken: "qgg8vlvZRS6UYooatFL8Aw" },
			}),
			{ "Content-Type": "application/json" },
		);
		const stored = env.DB.raw.query("SELECT id, status FROM webhook_events").all() as {
			id: string;
			status: string;
		}[];
		expect(stored).toHaveLength(1);
		expect(stored[0].status).toBe("handshake");

		// A handshake is evidence that a provider's setup call arrived and what we
		// answered. It is not work, and an agent must never be handed it as work.
		expect((await json<{ count: number }>(await lease({ limit: 10 }))).count).toBe(0);
		expect(row(stored[0].id).status).toBe("handshake");
	});

	test("never leases a rejected row", async () => {
		env.DB.raw
			.query(
				`INSERT INTO webhook_events (id, receiver_id, inbox, slug, method, status, created_at, expires_at)
				 VALUES ('ev-rejected', 'r', 'lisa', 'gh', 'POST', 'rejected', 1, 9999999999999)`,
			)
			.run();
		expect((await json<{ count: number }>(await lease({ limit: 10 }))).count).toBe(0);
	});

	test("stays inside the box the gate approved", async () => {
		await deliverMany(2, "bob", "other");
		expect((await json<{ count: number }>(await lease({ limit: 10 }))).count).toBe(0);
		expect(
			env.DB.raw.query("SELECT * FROM webhook_events WHERE status = 'queued'").all(),
		).toHaveLength(2);
	});

	test("filters to one receiver", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "stripe" });
		await deliverMany(2, "lisa", "gh");
		const [wanted] = await deliverMany(1, "lisa", "stripe");

		const got = await json<{ events: { id: string }[] }>(
			await lease({ limit: 10, receiver: "stripe" }),
		);
		expect(got.events.map((e) => e.id)).toEqual([wanted]);
	});

	test("--remove collapses it to at-most-once at handout", async () => {
		const ids = await deliverMany(2);

		const got = await json<{ count: number; lease_id: string | null }>(
			await lease({ limit: 2, remove: true }),
		);

		expect(got.count).toBe(2);
		// No lease to report, because nothing is being held.
		expect(got.lease_id).toBeNull();
		for (const id of ids) {
			const r = row(id);
			expect(r.status).toBe("acked");
			expect(r.acked_at).toBeGreaterThan(0);
			expect(r.leased_until).toBeNull();
		}
		expect((await json<{ count: number }>(await lease({ limit: 5 }))).count).toBe(0);
	});

	test("needs a write key -- a reader may look but not consume", async () => {
		await deliverMany(1);
		expect((await lease({ limit: 1 }, READER)).status).toBe(403);
		expect(
			env.DB.raw.query("SELECT * FROM webhook_events WHERE status = 'queued'").all(),
		).toHaveLength(1);
	});
});

describe("queue-peek: takes nothing, changes nothing", () => {
	test("leaves every column byte-identical, including on a leased message", async () => {
		const ids = await deliverMany(2);
		await lease({ limit: 1, leaseSeconds: 300 });

		// One leased, one queued -- peek must be inert on both, and the leased one is
		// the case that matters: looking at what a consumer is holding must not
		// disturb the hold.
		const before = ids.map(row);
		await post("/api/hooks/queue/lisa/peek", READER);
		await get(`/api/hooks/queue/lisa/${ids[0]}`, READER);
		await get(`/api/hooks/queue/lisa/${ids[0]}/body`, READER);
		await get("/api/hooks/queue/lisa", READER);
		await get("/api/hooks/queue/lisa/stats", READER);

		expect(ids.map(row)).toEqual(before);
	});

	test("shows who holds the lease and until when", async () => {
		const [id] = await deliverMany(1);
		const held = await json<{ lease_id: string; leased_until: number }>(
			await lease({ limit: 1, leaseSeconds: 120 }),
		);

		const peeked = await json<{ lease_id: string; leased_until: number; status: string }>(
			await get(`/api/hooks/queue/lisa/${id}`, READER),
		);
		expect(peeked.status).toBe("leased");
		expect(peeked.lease_id).toBe(held.lease_id);
		expect(peeked.leased_until).toBe(held.leased_until);
	});
});

describe("queue-remove: the ack", () => {
	test("takes it off the queue and keeps the row", async () => {
		const [id] = await deliverMany(1);
		await lease({ limit: 1 });

		const res = await json<{ removed: number }>(
			await post("/api/hooks/queue/lisa/remove", WRITER, { ids: [id] }),
		);

		expect(res.removed).toBe(1);
		const r = row(id);
		expect(r.status).toBe("acked");
		expect(r.acked_at).toBeGreaterThan(0);
		expect(r.lease_id).toBeNull();
		// The row survives: audit and replay both need it until it expires.
		expect(r.body_text).toBe('{"n":0}');
	});

	test("is idempotent, and does not restamp acked_at", async () => {
		const [id] = await deliverMany(1);
		await post("/api/hooks/queue/lisa/remove", WRITER, { ids: [id] });
		const firstAck = row(id).acked_at;

		await new Promise((resolve) => setTimeout(resolve, 3));
		const second = await json<{ removed: number; already_removed: number }>(
			await post("/api/hooks/queue/lisa/remove", WRITER, { ids: [id] }),
		);

		expect(second.removed).toBe(0);
		expect(second.already_removed).toBe(1);
		// acked_at still says when the work actually finished.
		expect(row(id).acked_at).toBe(firstAck);
	});

	test("reports an id that is not in this box instead of touching it", async () => {
		const [mine] = await deliverMany(1, "lisa", "gh");
		const theirs = await deliver("bob", "other", "{}");

		const res = await json<{ removed: number; missing: number }>(
			await post("/api/hooks/queue/lisa/remove", WRITER, { ids: [mine, theirs.id, "nope"] }),
		);

		expect(res.removed).toBe(1);
		expect(res.missing).toBe(2);
		// The other box's event is untouched: an id alone is never authorization.
		expect(row(theirs.id).status).toBe("queued");
	});

	test("refuses to ack a handshake row -- that is evidence, not work", async () => {
		env.DB.raw
			.query(
				`INSERT INTO webhook_events (id, receiver_id, inbox, slug, method, status, created_at, expires_at)
				 VALUES ('ev-hs', 'r', 'lisa', 'gh', 'POST', 'handshake', 1, 9999999999999)`,
			)
			.run();

		const res = await json<{ removed: number; skipped_handshake: number }>(
			await post("/api/hooks/queue/lisa/remove", WRITER, { ids: ["ev-hs"] }),
		);

		expect(res.removed).toBe(0);
		expect(res.skipped_handshake).toBe(1);
		expect(row("ev-hs").status).toBe("handshake");
	});

	test("an empty id list is a 400, not a silent no-op", async () => {
		expect((await post("/api/hooks/queue/lisa/remove", WRITER, { ids: [] })).status).toBe(400);
	});
});

describe("queue-return and queue-extend", () => {
	test("return frees the lease immediately", async () => {
		const [id] = await deliverMany(1);
		await lease({ limit: 1, leaseSeconds: 3600 });

		const res = await json<{ returned: number }>(
			await post("/api/hooks/queue/lisa/return", WRITER, { ids: [id] }),
		);

		expect(res.returned).toBe(1);
		const r = row(id);
		expect(r.status).toBe("queued");
		expect(r.lease_id).toBeNull();
		expect(r.leased_until).toBeNull();
		// Available again now, not in an hour.
		expect((await json<{ count: number }>(await lease({ limit: 5 }))).count).toBe(1);
	});

	test("extend pushes leased_until out without changing ownership", async () => {
		const [id] = await deliverMany(1);
		const held = await json<{ lease_id: string; leased_until: number }>(
			await lease({ limit: 1, leaseSeconds: 30 }),
		);

		const res = await json<{ extended: number }>(
			await post("/api/hooks/queue/lisa/extend", WRITER, {
				ids: [id],
				leaseSeconds: 600,
				leaseId: held.lease_id,
			}),
		);

		expect(res.extended).toBe(1);
		const r = row(id);
		expect(r.leased_until).toBeGreaterThan(held.leased_until);
		// Same handout continuing: the holder is unchanged and the count is not bumped.
		expect(r.lease_id).toBe(held.lease_id);
		expect(r.lease_count).toBe(1);
		expect(r.status).toBe("leased");
	});

	test("extend refuses a lease that is not yours", async () => {
		const [id] = await deliverMany(1);
		const held = await json<{ leased_until: number }>(await lease({ limit: 1, leaseSeconds: 30 }));

		const res = await json<{ extended: number }>(
			await post("/api/hooks/queue/lisa/extend", WRITER, {
				ids: [id],
				leaseSeconds: 600,
				leaseId: crypto.randomUUID(),
			}),
		);

		expect(res.extended).toBe(0);
		expect(row(id).leased_until).toBe(held.leased_until);
	});

	test("extend will not resurrect an expired lease", async () => {
		const [id] = await deliverMany(1);
		await lease({ limit: 1, leaseSeconds: 30 });
		env.DB.raw.query("UPDATE webhook_events SET leased_until = ? WHERE id = ?").run(1, id);

		// It is back in the pool and may already be someone else's; taking it back
		// silently is worse than making the caller pull again.
		const res = await json<{ extended: number }>(
			await post("/api/hooks/queue/lisa/extend", WRITER, { ids: [id], leaseSeconds: 600 }),
		);

		expect(res.extended).toBe(0);
		expect(row(id).leased_until).toBe(1);
	});
});

describe("queue-requeue", () => {
	test("puts a removed event back on the queue", async () => {
		const [id] = await deliverMany(1);
		await post("/api/hooks/queue/lisa/remove", WRITER, { ids: [id] });

		const res = await json<{ requeued: number }>(
			await post("/api/hooks/queue/lisa/requeue", WRITER, { ids: [id] }),
		);

		expect(res.requeued).toBe(1);
		const r = row(id);
		expect(r.status).toBe("queued");
		expect(r.acked_at).toBeNull();
		expect((await json<{ count: number }>(await lease({ limit: 5 }))).count).toBe(1);
	});

	test("puts a rejected event back too -- that is how a fixed secret is retried", async () => {
		env.DB.raw
			.query(
				`INSERT INTO webhook_events (id, receiver_id, inbox, slug, method, status, verified, created_at, expires_at)
				 VALUES ('ev-rej', 'r', 'lisa', 'gh', 'POST', 'rejected', 0, 1, 9999999999999)`,
			)
			.run();

		const res = await json<{ requeued: number }>(
			await post("/api/hooks/queue/lisa/requeue", WRITER, { ids: ["ev-rej"] }),
		);

		expect(res.requeued).toBe(1);
		expect(row("ev-rej").status).toBe("queued");
		// The verdict is history and stays false: requeueing does not re-verify it.
		expect(row("ev-rej").verified).toBe(0);
	});

	test("offers a handshake row no way in", async () => {
		env.DB.raw
			.query(
				`INSERT INTO webhook_events (id, receiver_id, inbox, slug, method, status, created_at, expires_at)
				 VALUES ('ev-hs', 'r', 'lisa', 'gh', 'POST', 'handshake', 1, 9999999999999)`,
			)
			.run();

		const res = await json<{ requeued: number }>(
			await post("/api/hooks/queue/lisa/requeue", WRITER, { ids: ["ev-hs"] }),
		);

		// The lease SELECT already excludes handshakes; this is the other door, and
		// it is closed too. A provider's setup call is never an agent's work item.
		expect(res.requeued).toBe(0);
		expect(row("ev-hs").status).toBe("handshake");
	});
});
