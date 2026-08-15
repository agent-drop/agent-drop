/**
 * Retention: what the hourly cron destroys, and what it must not touch.
 *
 * Every assertion reads the rows back with `env.DB.raw.query` and the objects
 * back off the bucket. A reaper that reports "deleted 3" while leaving three
 * rows -- or that reports the same while quietly taking a fourth -- is the exact
 * failure worth catching, and its own summary is a claim rather than the fact.
 */

import { describe, expect, test } from "bun:test";
import { HOOK_REAP_BATCH, reapExpiredEvents } from "../src/lib/hook-reaper";
import { runSweeps, STALE_AFTER_MS } from "../src/lib/reaper";
import { retentionFor } from "../src/lib/webhook-store";
import worker from "../src/index";
import {
	makeBucket,
	makeCtx,
	makeEnv,
	seedPendingDrop,
	seedReceiver,
	type TestEnv,
} from "./helpers/env";
import type { WebhookReceiver } from "../src/types";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

interface SeedEvent {
	id: string;
	receiverId: string;
	expiresAt: number;
	status?: string;
	bodyKey?: string | null;
}

async function seedEvent(env: TestEnv, e: SeedEvent) {
	await env.DB.prepare(
		`INSERT INTO webhook_events
			(id, receiver_id, inbox, slug, method, status, body_r2_key, created_at, expires_at)
		 VALUES (?, ?, 'lisa', 'gh', 'POST', ?, ?, ?, ?)`,
	)
		.bind(
			e.id,
			e.receiverId,
			e.status ?? "queued",
			e.bodyKey ?? null,
			e.expiresAt - 120 * DAY,
			e.expiresAt,
		)
		.run();
}

function eventIds(env: TestEnv): string[] {
	return (
		env.DB.raw.query("SELECT id FROM webhook_events ORDER BY id").all() as { id: string }[]
	).map((r) => r.id);
}

async function setup(objects: Record<string, string | Uint8Array> = {}) {
	const bucket = makeBucket(objects);
	const env = makeEnv({ BUCKET: bucket });
	const receiverId = await seedReceiver(env, { inbox: "lisa", slug: "gh" });
	return { env, bucket, receiverId };
}

describe("the webhook-event retention sweep", () => {
	test("destroys an event past its expires_at and leaves an unexpired one", async () => {
		const { env, receiverId } = await setup();
		await seedEvent(env, { id: "expired", receiverId, expiresAt: NOW - 1 });
		await seedEvent(env, { id: "current", receiverId, expiresAt: NOW + DAY });

		const summary = await reapExpiredEvents(env, NOW);

		expect(summary).toEqual({ scanned: 1, deleted: 1, bodies: 0, kept: 0 });
		expect(eventIds(env)).toEqual(["current"]);
	});

	// Bodies before rows: an orphaned R2 object is invisible and bills forever.
	test("takes the R2 body with the row", async () => {
		const key = "hooks/lisa/gh/expired";
		const { env, bucket } = await setup({ [key]: "the raw bytes" });
		const receiverId = await seedReceiver(env, { inbox: "lisa", slug: "gh2" });
		await seedEvent(env, { id: "expired", receiverId, expiresAt: NOW - 1, bodyKey: key });

		const summary = await reapExpiredEvents(env, NOW);

		expect(summary).toEqual({ scanned: 1, deleted: 1, bodies: 1, kept: 0 });
		expect(bucket.deletes).toEqual([key]);
		expect(await bucket.get(key)).toBeNull();
		expect(eventIds(env)).toEqual([]);
	});

	test("an unexpired event's body is not touched", async () => {
		const key = "hooks/lisa/gh/current";
		const { env, bucket, receiverId } = await setup({ [key]: "keep me" });
		await seedEvent(env, { id: "current", receiverId, expiresAt: NOW + 1, bodyKey: key });

		await reapExpiredEvents(env, NOW);

		expect(bucket.deletes).toEqual([]);
		expect(await bucket.get(key)).not.toBeNull();
		expect(eventIds(env)).toEqual(["current"]);
	});

	// The row is the only record of which object belonged to it. Deleting it after
	// a failed body delete strands the bytes with nothing pointing at them.
	test("keeps the row when its body will not delete, and retries next run", async () => {
		const { env, receiverId } = await setup();
		let failing = true;
		env.BUCKET = {
			delete: async () => {
				if (failing) throw new Error("R2 unavailable");
			},
		} as unknown as R2Bucket;
		await seedEvent(env, {
			id: "stuck",
			receiverId,
			expiresAt: NOW - 1,
			bodyKey: "hooks/lisa/gh/stuck",
		});

		const first = await reapExpiredEvents(env, NOW);
		expect(first).toEqual({ scanned: 1, deleted: 0, bodies: 0, kept: 1 });
		expect(eventIds(env)).toEqual(["stuck"]);

		failing = false;
		const second = await reapExpiredEvents(env, NOW);
		expect(second).toEqual({ scanned: 1, deleted: 1, bodies: 1, kept: 0 });
		expect(eventIds(env)).toEqual([]);
	});

	test("one stuck body does not stop the rest of the batch", async () => {
		const { env, receiverId } = await setup();
		env.BUCKET = {
			delete: async (key: string) => {
				if (key.endsWith("stuck")) throw new Error("R2 unavailable");
			},
		} as unknown as R2Bucket;
		await seedEvent(env, {
			id: "a-stuck",
			receiverId,
			expiresAt: NOW - 2,
			bodyKey: "hooks/lisa/gh/stuck",
		});
		await seedEvent(env, {
			id: "b-fine",
			receiverId,
			expiresAt: NOW - 1,
			bodyKey: "hooks/lisa/gh/fine",
		});

		const summary = await reapExpiredEvents(env, NOW);

		expect(summary).toEqual({ scanned: 2, deleted: 1, bodies: 1, kept: 1 });
		expect(eventIds(env)).toEqual(["a-stuck"]);
	});

	test("the boundary is exclusive: expiring exactly now has not expired", async () => {
		const { env, receiverId } = await setup();
		await seedEvent(env, { id: "edge", receiverId, expiresAt: NOW });

		expect((await reapExpiredEvents(env, NOW)).scanned).toBe(0);
		expect((await reapExpiredEvents(env, NOW + 1)).scanned).toBe(1);
	});

	test("every status expires, including the ones that never joined the queue", async () => {
		const { env, receiverId } = await setup();
		for (const status of ["queued", "leased", "acked", "rejected", "handshake"]) {
			await seedEvent(env, { id: `e-${status}`, receiverId, expiresAt: NOW - 1, status });
		}

		const summary = await reapExpiredEvents(env, NOW);

		expect(summary.deleted).toBe(5);
		expect(eventIds(env)).toEqual([]);
	});

	test("caps one run at HOOK_REAP_BATCH rows, oldest expiry first", async () => {
		const { env, receiverId } = await setup();
		for (let i = 0; i < HOOK_REAP_BATCH + 3; i++) {
			await seedEvent(env, {
				id: `e${String(i).padStart(4, "0")}`,
				receiverId,
				expiresAt: NOW - (HOOK_REAP_BATCH + 3 - i),
			});
		}

		const summary = await reapExpiredEvents(env, NOW);

		expect(summary.scanned).toBe(HOOK_REAP_BATCH);
		expect(summary.deleted).toBe(HOOK_REAP_BATCH);
		// The survivors are the three that expired most recently.
		expect(eventIds(env)).toEqual([
			`e${String(HOOK_REAP_BATCH).padStart(4, "0")}`,
			`e${String(HOOK_REAP_BATCH + 1).padStart(4, "0")}`,
			`e${String(HOOK_REAP_BATCH + 2).padStart(4, "0")}`,
		]);
	});
});

describe("what expires_at was stamped with at insert", () => {
	const receiver = { retention_days: 120 } as WebhookReceiver;

	test("a rejected event keeps 7 days, not the receiver's retention", () => {
		expect(retentionFor(receiver, "rejected")).toBe(7);
	});

	test("everything else keeps the receiver's retention", () => {
		expect(retentionFor(receiver, "queued")).toBe(120);
		expect(retentionFor(receiver, "handshake")).toBe(120);
		expect(retentionFor({ retention_days: 30 } as WebhookReceiver, "queued")).toBe(30);
	});

	// Stamped at insert, never recomputed at read: raising a receiver's retention
	// must not resurrect what has aged out, and lowering it must not retroactively
	// destroy history somebody was promised.
	test("the sweep reads the stamp, not the receiver's current setting", async () => {
		const { env, receiverId } = await setup();
		await seedEvent(env, { id: "stamped", receiverId, expiresAt: NOW - 1 });
		await env.DB.prepare("UPDATE webhook_receivers SET retention_days = 3650 WHERE id = ?")
			.bind(receiverId)
			.run();

		expect((await reapExpiredEvents(env, NOW)).deleted).toBe(1);
	});
});

describe("the hourly cron runs both sweeps", () => {
	test("runSweeps reaps drops and events in one tick", async () => {
		const { env, receiverId } = await setup();
		await seedPendingDrop(env, {
			id: "gone",
			inbox: "lisa",
			createdAt: NOW - STALE_AFTER_MS - 1,
		});
		await seedEvent(env, { id: "expired", receiverId, expiresAt: NOW - 1 });

		const summary = await runSweeps(env, NOW);

		expect(summary.drops).toEqual({ scanned: 1, completed: 0, deleted: 1, skipped: 0 });
		expect(summary.events).toEqual({ scanned: 1, deleted: 1, bodies: 0, kept: 0 });
		expect(eventIds(env)).toEqual([]);
	});

	// A D1 or R2 hiccup in one sweep is no reason for the bucket to quietly stop
	// expiring, so the two are settled rather than chained.
	test("a failing drop sweep does not stop the event sweep", async () => {
		const { env, receiverId } = await setup();
		env.BUCKET = {
			head: async () => {
				throw new Error("R2 unavailable");
			},
			delete: async () => {},
		} as unknown as R2Bucket;
		await seedPendingDrop(env, {
			id: "unresolvable",
			inbox: "lisa",
			createdAt: NOW - STALE_AFTER_MS - 1,
		});
		await seedEvent(env, { id: "expired", receiverId, expiresAt: NOW - 1 });

		const summary = await runSweeps(env, NOW);

		expect(summary.drops).toBeNull();
		expect(summary.events).toEqual({ scanned: 1, deleted: 1, bodies: 0, kept: 0 });
		expect(eventIds(env)).toEqual([]);
	});

	test("the worker's scheduled export destroys an expired event and its body", async () => {
		const key = "hooks/lisa/gh/old";
		const { env, bucket } = await setup({ [key]: "bytes" });
		const receiverId = await seedReceiver(env, { inbox: "lisa", slug: "gh3" });
		await seedEvent(env, {
			id: "old",
			receiverId,
			expiresAt: Date.now() - 1,
			bodyKey: key,
		});
		const ctx = makeCtx();

		await worker.scheduled(
			{ scheduledTime: Date.now(), cron: "17 * * * *", noRetry: () => {} },
			env,
			ctx,
		);

		expect(ctx.waits).toHaveLength(1);
		await ctx.settle();
		expect(eventIds(env)).toEqual([]);
		expect(bucket.deletes).toEqual([key]);
	});
});
