import { describe, expect, test } from "bun:test";
import { handleAPI } from "../src/api/router";
import {
	parseUploadKey,
	processR2Event,
	processR2EventBatch,
	R2_EVENT_QUEUE,
	type R2EventNotification,
} from "../src/lib/r2-events";
import worker from "../src/index";
import {
	dropStatus,
	jsonRequest,
	makeCtx,
	makeEnv,
	seedApiKey,
	seedPendingDrop,
	type TestEnv,
} from "./helpers/env";

const BASE = "https://drop.test";

function event(key: string, overrides: Partial<R2EventNotification> = {}): R2EventNotification {
	return {
		account: "acct",
		action: "PutObject",
		bucket: "agent-drop-storage",
		object: { key, size: 1234, eTag: "abc" },
		eventTime: new Date(0).toISOString(),
		...overrides,
	};
}

describe("parseUploadKey", () => {
	test("recovers inbox and drop id from a presigned upload key", () => {
		expect(parseUploadKey("drops/lisa/01hq/uploads/report.pdf")).toEqual({
			inbox: "lisa",
			dropId: "01hq",
		});
	});

	test("keeps the file name out of it, however nested", () => {
		expect(parseUploadKey("drops/lisa/01hq/uploads/a/b/c.pdf")).toEqual({
			inbox: "lisa",
			dropId: "01hq",
		});
	});

	test.each([
		["drops/lisa/01hq/attachments/logo.png", "an email attachment"],
		["drops/lisa/01hq/raw.eml", "a stored raw email"],
		["sites/lisa/marketing/index.html", "a hosted site file"],
		["outbound/temp/x.zip", "an outbound attachment"],
		["drops/lisa/01hq/uploads", "the uploads prefix with no file"],
		["", "an empty key"],
	])("ignores %s (%s)", (key) => {
		expect(parseUploadKey(key)).toBeNull();
	});
});

describe("processR2Event", () => {
	test("completes the pending drop whose recorded key just landed", async () => {
		const env = makeEnv();
		await seedPendingDrop(env, { id: "d1", inbox: "lisa", fileName: "report.pdf" });

		const outcome = await processR2Event(env, event("drops/lisa/d1/uploads/report.pdf"));

		expect(outcome).toEqual({ result: "completed", dropId: "d1" });
		expect(dropStatus(env, "d1")).toBe("completed");
	});

	test("completes a pre-0008 row that has no recorded key", async () => {
		const env = makeEnv();
		await seedPendingDrop(env, { id: "d1", inbox: "lisa", objectKey: null });

		const outcome = await processR2Event(env, event("drops/lisa/d1/uploads/report.pdf"));

		expect(outcome.result).toBe("completed");
		expect(dropStatus(env, "d1")).toBe("completed");
	});

	test("will not complete a drop from a key it was not signed for", async () => {
		const env = makeEnv();
		await seedPendingDrop(env, { id: "d1", inbox: "lisa", fileName: "report.pdf" });

		// Same drop id and inbox, different file: not the object this drop's
		// presign was signed against.
		const outcome = await processR2Event(env, event("drops/lisa/d1/uploads/other.pdf"));

		expect(outcome).toEqual({ result: "no-match", dropId: "d1" });
		expect(dropStatus(env, "d1")).toBe("pending");
	});

	test("will not complete a drop belonging to another box", async () => {
		const env = makeEnv();
		await seedPendingDrop(env, { id: "d1", inbox: "lisa", fileName: "report.pdf" });

		const outcome = await processR2Event(env, event("drops/bob/d1/uploads/report.pdf"));

		expect(outcome.result).toBe("no-match");
		expect(dropStatus(env, "d1")).toBe("pending");
	});

	test("is idempotent -- a redelivered notification changes nothing", async () => {
		const env = makeEnv();
		await seedPendingDrop(env, { id: "d1", inbox: "lisa", fileName: "report.pdf" });
		const key = "drops/lisa/d1/uploads/report.pdf";

		expect((await processR2Event(env, event(key))).result).toBe("completed");
		expect((await processR2Event(env, event(key))).result).toBe("no-match");
		expect(dropStatus(env, "d1")).toBe("completed");
	});

	test("multipart completion counts as the object landing", async () => {
		const env = makeEnv();
		await seedPendingDrop(env, { id: "d1", inbox: "lisa", fileName: "big.zip" });

		const outcome = await processR2Event(
			env,
			event("drops/lisa/d1/uploads/big.zip", { action: "CompleteMultipartUpload" }),
		);

		expect(outcome.result).toBe("completed");
	});

	test("a delete notification never completes anything", async () => {
		const env = makeEnv();
		await seedPendingDrop(env, { id: "d1", inbox: "lisa", fileName: "report.pdf" });

		const outcome = await processR2Event(
			env,
			event("drops/lisa/d1/uploads/report.pdf", {
				action: "DeleteObject",
				object: { key: "drops/lisa/d1/uploads/report.pdf" },
			}),
		);

		expect(outcome).toEqual({ result: "ignored" });
		expect(dropStatus(env, "d1")).toBe("pending");
	});

	test("an email attachment landing does not touch any drop", async () => {
		const env = makeEnv();
		await seedPendingDrop(env, { id: "d1", inbox: "lisa" });

		const outcome = await processR2Event(env, event("drops/lisa/d1/attachments/logo.png"));

		expect(outcome).toEqual({ result: "ignored" });
		expect(dropStatus(env, "d1")).toBe("pending");
	});
});

function messages(events: R2EventNotification[]) {
	const acked: number[] = [];
	const retried: number[] = [];
	return {
		acked,
		retried,
		batch: {
			queue: R2_EVENT_QUEUE,
			messages: events.map((body, i) => ({
				id: String(i),
				body,
				ack: () => acked.push(i),
				retry: () => retried.push(i),
			})),
		} as unknown as MessageBatch<R2EventNotification>,
	};
}

describe("the R2 event queue consumer", () => {
	test("acks every message it handled", async () => {
		const env = makeEnv();
		await seedPendingDrop(env, { id: "d1", inbox: "lisa", fileName: "a.pdf" });
		await seedPendingDrop(env, { id: "d2", inbox: "lisa", fileName: "b.pdf" });

		const { acked, retried, batch } = messages([
			event("drops/lisa/d1/uploads/a.pdf"),
			event("drops/lisa/d2/uploads/b.pdf"),
		]);
		await processR2EventBatch(batch, env);

		expect(acked).toEqual([0, 1]);
		expect(retried).toEqual([]);
		expect(dropStatus(env, "d1")).toBe("completed");
		expect(dropStatus(env, "d2")).toBe("completed");
	});

	test("retries a message whose D1 write blew up, and does not poison the batch", async () => {
		const env = makeEnv();
		await seedPendingDrop(env, { id: "d2", inbox: "lisa", fileName: "b.pdf" });
		const realPrepare = env.DB.prepare.bind(env.DB);
		let firstUpdate = true;
		env.DB.prepare = ((sql: string) => {
			if (sql.startsWith("UPDATE drops") && firstUpdate) {
				firstUpdate = false;
				return {
					bind: () => ({
						run: async () => {
							throw new Error("D1 unavailable");
						},
					}),
				} as unknown as ReturnType<typeof realPrepare>;
			}
			return realPrepare(sql);
		}) as typeof env.DB.prepare;

		const { acked, retried, batch } = messages([
			event("drops/lisa/d1/uploads/a.pdf"),
			event("drops/lisa/d2/uploads/b.pdf"),
		]);
		await processR2EventBatch(batch, env);

		expect(retried).toEqual([0]);
		expect(acked).toEqual([1]);
		expect(dropStatus(env, "d2")).toBe("completed");
	});

	test("the worker entry point routes by queue name", async () => {
		const env = makeEnv();
		await seedPendingDrop(env, { id: "d1", inbox: "lisa", fileName: "a.pdf" });

		const { batch } = messages([event("drops/lisa/d1/uploads/a.pdf")]);
		await worker.queue(batch, env);

		expect(dropStatus(env, "d1")).toBe("completed");
	});
});

// The confirm endpoint is no longer the only thing that completes a drop, so
// "already completed" became the normal outcome of a healthy upload. It used to
// answer 404 there, which would surface the R2 consumer winning the race as a
// failed upload in the SPA.
describe("POST /api/upload/confirm is idempotent", () => {
	const body = (res: Response) => res.json() as Promise<Record<string, unknown>>;

	async function confirm(env: TestEnv, dropId: string) {
		return handleAPI(
			jsonRequest(`${BASE}/api/upload/confirm`, { dropId }, { Authorization: "Bearer ad_w" }),
			env,
			new URL(`${BASE}/api/upload/confirm`),
			makeCtx(),
		);
	}

	test("confirming a drop the R2 notification already completed succeeds", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_w", { permissions: "write" });
		await seedPendingDrop(env, { id: "d1", inbox: "lisa", fileName: "a.pdf" });

		await processR2Event(env, event("drops/lisa/d1/uploads/a.pdf"));
		const res = await confirm(env, "d1");

		expect(res.status).toBe(200);
		expect(await body(res)).toEqual({ confirmed: true, dropId: "d1", alreadyCompleted: true });
	});

	test("confirming first still works, and reports it did the work", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_w", { permissions: "write" });
		await seedPendingDrop(env, { id: "d1", inbox: "lisa", fileName: "a.pdf" });

		const res = await confirm(env, "d1");

		expect(res.status).toBe(200);
		expect(await body(res)).toEqual({ confirmed: true, dropId: "d1", alreadyCompleted: false });
		expect(dropStatus(env, "d1")).toBe("completed");
	});

	test("confirming twice is still a success", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_w", { permissions: "write" });
		await seedPendingDrop(env, { id: "d1", inbox: "lisa", fileName: "a.pdf" });

		await confirm(env, "d1");
		const res = await confirm(env, "d1");

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ confirmed: true, alreadyCompleted: true });
	});

	test("an unknown drop id is still a 404, not a silent success", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_w", { permissions: "write" });

		const res = await confirm(env, "nope");

		expect(res.status).toBe(404);
	});
});
