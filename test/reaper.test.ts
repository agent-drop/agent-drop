import { describe, expect, test } from "bun:test";
import { REAP_BATCH, reapPendingDrops, STALE_AFTER_MS, runScheduled } from "../src/lib/reaper";
import worker from "../src/index";
import { dropStatus, makeBucket, makeCtx, makeEnv, seedPendingDrop } from "./helpers/env";

const NOW = 1_800_000_000_000;
const OLD = NOW - STALE_AFTER_MS - 60_000;
const RECENT = NOW - 60_000;

function dropIds(env: ReturnType<typeof makeEnv>): string[] {
	return (env.DB.raw.query("SELECT id FROM drops ORDER BY id").all() as { id: string }[]).map(
		(r) => r.id,
	);
}

describe("the reaper's selection policy", () => {
	test("leaves a pending drop that is not yet stale alone", async () => {
		const env = makeEnv({ BUCKET: makeBucket() });
		await seedPendingDrop(env, { id: "fresh", inbox: "lisa", createdAt: RECENT });

		const summary = await reapPendingDrops(env, NOW);

		expect(summary).toEqual({ scanned: 0, completed: 0, deleted: 0, skipped: 0 });
		expect(dropIds(env)).toEqual(["fresh"]);
	});

	test("leaves a completed drop alone however old it is", async () => {
		const env = makeEnv({ BUCKET: makeBucket() });
		await seedPendingDrop(env, {
			id: "done",
			inbox: "lisa",
			status: "completed",
			createdAt: OLD - 10 * STALE_AFTER_MS,
		});

		const summary = await reapPendingDrops(env, NOW);

		expect(summary.scanned).toBe(0);
		expect(dropIds(env)).toEqual(["done"]);
	});

	test("deletes a stale pending drop whose object never landed", async () => {
		const env = makeEnv({ BUCKET: makeBucket() });
		await seedPendingDrop(env, {
			id: "abandoned",
			inbox: "lisa",
			fileName: "a.pdf",
			createdAt: OLD,
		});

		const summary = await reapPendingDrops(env, NOW);

		expect(summary).toEqual({ scanned: 1, completed: 0, deleted: 1, skipped: 0 });
		expect(dropIds(env)).toEqual([]);
	});

	// The PLAN only asked for deletion. Deleting a drop whose bytes are sitting
	// in the bucket would be data loss dressed up as cleanup, so the reaper asks
	// R2 first and rescues that case instead.
	test("completes a stale pending drop whose object DID land", async () => {
		const env = makeEnv({
			BUCKET: makeBucket({ "drops/lisa/landed/uploads/a.pdf": "bytes" }),
		});
		await seedPendingDrop(env, { id: "landed", inbox: "lisa", fileName: "a.pdf", createdAt: OLD });

		const summary = await reapPendingDrops(env, NOW);

		expect(summary).toEqual({ scanned: 1, completed: 1, deleted: 0, skipped: 0 });
		expect(dropStatus(env, "landed")).toBe("completed");
	});

	test("checks R2 at the key the drop actually recorded", async () => {
		const bucket = makeBucket();
		const env = makeEnv({ BUCKET: bucket });
		await seedPendingDrop(env, {
			id: "d1",
			inbox: "lisa",
			objectKey: "drops/lisa/d1/uploads/renamed.pdf",
			createdAt: OLD,
		});

		await reapPendingDrops(env, NOW);

		expect(bucket.heads).toEqual(["drops/lisa/d1/uploads/renamed.pdf"]);
	});

	test("rebuilds the key for a pre-0008 row that has none", async () => {
		const bucket = makeBucket();
		const env = makeEnv({ BUCKET: bucket });
		await seedPendingDrop(env, {
			id: "old",
			inbox: "lisa",
			fileName: "Report Draft.pdf",
			objectKey: null,
			createdAt: OLD,
		});

		const summary = await reapPendingDrops(env, NOW);

		// `subject` holds the original filename; presign slugified it.
		expect(bucket.heads).toEqual(["drops/lisa/old/uploads/report-draft.pdf"]);
		expect(summary.deleted).toBe(1);
	});

	test("skips -- never deletes -- a row it cannot resolve a key for", async () => {
		const env = makeEnv({ BUCKET: makeBucket() });
		await seedPendingDrop(env, { id: "d1", inbox: "lisa", objectKey: null, createdAt: OLD });
		env.DB.raw.query("UPDATE drops SET r2_prefix = NULL, subject = NULL WHERE id = ?").run("d1");

		const summary = await reapPendingDrops(env, NOW);

		expect(summary).toEqual({ scanned: 1, completed: 0, deleted: 0, skipped: 1 });
		expect(dropIds(env)).toEqual(["d1"]);
	});

	test("sorts oldest first and caps one run at REAP_BATCH rows", async () => {
		const env = makeEnv({ BUCKET: makeBucket() });
		for (let i = 0; i < REAP_BATCH + 5; i++) {
			await seedPendingDrop(env, {
				id: `d${String(i).padStart(4, "0")}`,
				inbox: "lisa",
				createdAt: OLD - (REAP_BATCH + 5 - i),
			});
		}

		const summary = await reapPendingDrops(env, NOW);

		expect(summary.scanned).toBe(REAP_BATCH);
		expect(dropIds(env)).toHaveLength(5);
		// The five survivors are the newest, because selection is oldest-first.
		expect(dropIds(env)[0]).toBe(`d${String(REAP_BATCH).padStart(4, "0")}`);
	});

	test("the boundary is exclusive: exactly STALE_AFTER_MS old is not yet stale", async () => {
		const env = makeEnv({ BUCKET: makeBucket() });
		await seedPendingDrop(env, { id: "edge", inbox: "lisa", createdAt: NOW - STALE_AFTER_MS });

		expect((await reapPendingDrops(env, NOW)).scanned).toBe(0);

		await seedPendingDrop(env, {
			id: "past",
			inbox: "lisa",
			createdAt: NOW - STALE_AFTER_MS - 1,
		});
		expect((await reapPendingDrops(env, NOW)).scanned).toBe(1);
	});
});

// A multipart upload has no object in R2 until complete, however long it runs,
// and its part URLs can live up to 7 days. Judging it by created_at alone
// deleted the row of every upload still in flight after 24 hours, and complete
// then answered 404 for an upload that was going fine.
describe("the reaper and multipart uploads in flight", () => {
	const plan = (expiresAt: number) =>
		JSON.stringify({ multipart: true, multipart_plan: { expires_at: expiresAt } });

	test("leaves a day-old multipart drop alone while its part URLs still work", async () => {
		const env = makeEnv({ BUCKET: makeBucket() });
		await seedPendingDrop(env, {
			id: "big",
			inbox: "lisa",
			createdAt: OLD - 2 * STALE_AFTER_MS,
			metadata: plan(NOW + 60 * 60 * 1000),
		});

		expect((await reapPendingDrops(env, NOW)).scanned).toBe(0);
		expect(dropIds(env)).toEqual(["big"]);
	});

	test("gives it the same day of grace after its URLs die that a presign gets", async () => {
		const env = makeEnv({ BUCKET: makeBucket() });
		await seedPendingDrop(env, {
			id: "recent-death",
			inbox: "lisa",
			createdAt: OLD - 5 * STALE_AFTER_MS,
			metadata: plan(NOW - 60_000),
		});
		await seedPendingDrop(env, {
			id: "long-dead",
			inbox: "lisa",
			createdAt: OLD - 5 * STALE_AFTER_MS,
			metadata: plan(OLD),
		});

		const summary = await reapPendingDrops(env, NOW);

		expect(summary).toEqual({ scanned: 1, completed: 0, deleted: 1, skipped: 0 });
		expect(dropIds(env)).toEqual(["recent-death"]);
	});

	test("an in-flight row does not take a batch slot from the stale rows behind it", async () => {
		const env = makeEnv({ BUCKET: makeBucket() });
		for (let i = 0; i < REAP_BATCH; i++) {
			await seedPendingDrop(env, {
				id: `flight-${String(i).padStart(4, "0")}`,
				inbox: "lisa",
				createdAt: OLD - 3 * STALE_AFTER_MS,
				metadata: plan(NOW + 60 * 60 * 1000),
			});
		}
		await seedPendingDrop(env, { id: "stale", inbox: "lisa", createdAt: OLD });

		const summary = await reapPendingDrops(env, NOW);

		expect(summary.deleted).toBe(1);
		expect(dropIds(env)).not.toContain("stale");
	});

	test("unreadable metadata falls back to created_at instead of breaking the sweep", async () => {
		const env = makeEnv({ BUCKET: makeBucket() });
		await seedPendingDrop(env, { id: "garbled", inbox: "lisa", createdAt: OLD, metadata: "{not" });
		await seedPendingDrop(env, { id: "plain", inbox: "lisa", createdAt: OLD });

		const summary = await reapPendingDrops(env, NOW);

		expect(summary.deleted).toBe(2);
		expect(dropIds(env)).toEqual([]);
	});
});

describe("the scheduled handler", () => {
	test("runScheduled reaps and reports", async () => {
		const env = makeEnv({
			BUCKET: makeBucket({ "drops/lisa/landed/uploads/a.pdf": "bytes" }),
		});
		await seedPendingDrop(env, { id: "landed", inbox: "lisa", fileName: "a.pdf", createdAt: OLD });
		await seedPendingDrop(env, { id: "gone", inbox: "lisa", fileName: "b.pdf", createdAt: OLD });

		const summary = await runScheduled(env, NOW);

		expect(summary).toEqual({ scanned: 2, completed: 1, deleted: 1, skipped: 0 });
	});

	test("the worker's scheduled export defers the sweep and still does it", async () => {
		const env = makeEnv({ BUCKET: makeBucket() });
		await seedPendingDrop(env, {
			id: "gone",
			inbox: "lisa",
			createdAt: Date.now() - STALE_AFTER_MS - 1,
		});
		const ctx = makeCtx();

		await worker.scheduled(
			{ scheduledTime: Date.now(), cron: "17 * * * *", noRetry: () => {} },
			env,
			ctx,
		);

		expect(ctx.waits).toHaveLength(1);
		await ctx.settle();
		expect(dropIds(env)).toEqual([]);
	});

	test("a thrown reaper does not escape the scheduled handler", async () => {
		const env = makeEnv({
			BUCKET: {
				head: async () => {
					throw new Error("R2 unavailable");
				},
			} as unknown as R2Bucket,
		});
		await seedPendingDrop(env, {
			id: "gone",
			inbox: "lisa",
			createdAt: Date.now() - STALE_AFTER_MS - 1,
		});
		const ctx = makeCtx();

		await worker.scheduled(
			{ scheduledTime: Date.now(), cron: "17 * * * *", noRetry: () => {} },
			env,
			ctx,
		);
		await ctx.settle();

		// Nothing thrown, and nothing destroyed on the way down.
		expect(dropIds(env)).toEqual(["gone"]);
	});
});
