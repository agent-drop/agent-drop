import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleAPI } from "../src/api/router";
import {
	dropStatus,
	jsonRequest,
	makeCtx,
	makeEnv,
	seedApiKey,
	seedDropToken,
	seedPendingDrop,
	type TestEnv,
} from "./helpers/env";

const BASE = "https://drop.test";

function call(env: TestEnv, request: Request) {
	return handleAPI(request, env, new URL(request.url), makeCtx());
}

// The S3 side of a multipart completion. aws4fetch goes through global fetch, so
// stubbing it both keeps the tests offline and lets them assert exactly which
// R2 object key the worker signed.
const realFetch = globalThis.fetch;
let s3Urls: string[] = [];

function stubS3() {
	s3Urls = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		s3Urls.push(url);
		const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
		if (method === "GET") {
			return new Response(
				"<ListPartsResult><Part><PartNumber>1</PartNumber><ETag>\"abc\"</ETag></Part></ListPartsResult>",
				{ status: 200 },
			);
		}
		return new Response("<CompleteMultipartUploadResult/>", { status: 200 });
	}) as typeof fetch;
}

beforeEach(stubS3);
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("POST /api/upload/confirm requires write auth on the drop's inbox", () => {
	// REGRESSION: the router dispatched confirm with NO auth at all, on the
	// theory that "the dropId was already authenticated at presign". Nothing
	// re-checked the caller, so anyone who learned a drop id could flip it to
	// `completed` and publish it to every agent reading that inbox.
	test("rejects an unauthenticated caller and leaves the drop pending", async () => {
		const env = makeEnv();
		await seedPendingDrop(env, { id: "drop-confirm-1", inbox: "lisa" });

		const res = await call(env, jsonRequest(`${BASE}/api/upload/confirm`, { dropId: "drop-confirm-1" }));

		expect(res.status).toBe(401);
		expect(dropStatus(env, "drop-confirm-1")).toBe("pending");
	});

	test("rejects a valid API key scoped to a different inbox", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_other", { inboxScope: "bob", permissions: "write" });
		await seedPendingDrop(env, { id: "drop-confirm-2", inbox: "lisa" });

		const res = await call(
			env,
			jsonRequest(
				`${BASE}/api/upload/confirm`,
				{ dropId: "drop-confirm-2" },
				{ Authorization: "Bearer ad_other" },
			),
		);

		expect(res.status).toBe(403);
		expect(dropStatus(env, "drop-confirm-2")).toBe("pending");
	});

	test("rejects a read-only API key", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_reader", { permissions: "read" });
		await seedPendingDrop(env, { id: "drop-confirm-3", inbox: "lisa" });

		const res = await call(
			env,
			jsonRequest(
				`${BASE}/api/upload/confirm`,
				{ dropId: "drop-confirm-3" },
				{ Authorization: "Bearer ad_reader" },
			),
		);

		expect(res.status).toBe(403);
		expect(dropStatus(env, "drop-confirm-3")).toBe("pending");
	});

	test("accepts the write key that owns the inbox", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_writer", { inboxScope: "lisa", permissions: "write" });
		await seedPendingDrop(env, { id: "drop-confirm-4", inbox: "lisa" });

		const res = await call(
			env,
			jsonRequest(
				`${BASE}/api/upload/confirm`,
				{ dropId: "drop-confirm-4" },
				{ Authorization: "Bearer ad_writer" },
			),
		);

		expect(res.status).toBe(200);
		expect(dropStatus(env, "drop-confirm-4")).toBe("completed");
	});

	test("accepts the drop token issued for that inbox", async () => {
		const env = makeEnv();
		await seedDropToken(env, "tok-lisa", "lisa");
		await seedPendingDrop(env, { id: "drop-confirm-5", inbox: "lisa" });

		const res = await call(
			env,
			jsonRequest(`${BASE}/api/upload/confirm?auth=tok-lisa`, { dropId: "drop-confirm-5" }),
		);

		expect(res.status).toBe(200);
		expect(dropStatus(env, "drop-confirm-5")).toBe("completed");
	});

	test("rejects a drop token issued for a different inbox", async () => {
		const env = makeEnv();
		await seedDropToken(env, "tok-bob", "bob");
		await seedPendingDrop(env, { id: "drop-confirm-6", inbox: "lisa" });

		const res = await call(
			env,
			jsonRequest(`${BASE}/api/upload/confirm?auth=tok-bob`, { dropId: "drop-confirm-6" }),
		);

		expect(res.status).toBe(401);
		expect(dropStatus(env, "drop-confirm-6")).toBe("pending");
	});

	test("unknown drop id is a 404, not a 500", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_writer", { permissions: "write" });

		const res = await call(
			env,
			jsonRequest(
				`${BASE}/api/upload/confirm`,
				{ dropId: "nope" },
				{ Authorization: "Bearer ad_writer" },
			),
		);

		expect(res.status).toBe(404);
	});
});

describe("POST /api/upload/complete requires write auth on the drop's inbox", () => {
	test("rejects an unauthenticated caller before touching R2", async () => {
		const env = makeEnv();
		await seedPendingDrop(env, { id: "drop-mp-1", inbox: "lisa" });

		const res = await call(
			env,
			jsonRequest(`${BASE}/api/upload/complete`, {
				dropId: "drop-mp-1",
				uploadId: "upload-1",
				objectKey: "drops/lisa/drop-mp-1/uploads/report.pdf",
			}),
		);

		expect(res.status).toBe(401);
		expect(s3Urls).toHaveLength(0);
		expect(dropStatus(env, "drop-mp-1")).toBe("pending");
	});

	test("rejects a valid API key scoped to a different inbox", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_other", { inboxScope: "bob", permissions: "write" });
		await seedPendingDrop(env, { id: "drop-mp-2", inbox: "lisa" });

		const res = await call(
			env,
			jsonRequest(
				`${BASE}/api/upload/complete`,
				{ dropId: "drop-mp-2", uploadId: "upload-1" },
				{ Authorization: "Bearer ad_other" },
			),
		);

		expect(res.status).toBe(403);
		expect(s3Urls).toHaveLength(0);
		expect(dropStatus(env, "drop-mp-2")).toBe("pending");
	});
});

describe("POST /api/upload/complete derives the object key from the drop row", () => {
	// REGRESSION: `dropId` and `objectKey` were independent body fields and the
	// handler never checked they belonged to the same row, so a caller holding
	// one valid drop id could complete a multipart upload against any key in the
	// bucket -- including another box's drop -- and flip that row to `completed`.
	test("ignores a client-supplied objectKey pointing at another box", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_writer", { inboxScope: "lisa", permissions: "write" });
		await seedPendingDrop(env, { id: "drop-mine", inbox: "lisa", fileName: "mine.pdf" });
		await seedPendingDrop(env, { id: "drop-theirs", inbox: "bob", fileName: "secret.pdf" });

		const res = await call(
			env,
			jsonRequest(
				`${BASE}/api/upload/complete`,
				{
					dropId: "drop-mine",
					uploadId: "upload-1",
					objectKey: "drops/bob/drop-theirs/uploads/secret.pdf",
				},
				{ Authorization: "Bearer ad_writer" },
			),
		);

		expect(res.status).toBe(200);
		// Every R2 call must have used the key recorded for drop-mine at presign.
		expect(s3Urls.length).toBeGreaterThan(0);
		for (const url of s3Urls) {
			expect(url).toContain("drops/lisa/drop-mine/uploads/mine.pdf");
			expect(url).not.toContain("drop-theirs");
			expect(url).not.toContain("secret.pdf");
		}
		expect(dropStatus(env, "drop-mine")).toBe("completed");
		expect(dropStatus(env, "drop-theirs")).toBe("pending");
	});

	test("works without any objectKey in the body at all", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_writer", { permissions: "write" });
		await seedPendingDrop(env, { id: "drop-nokey", inbox: "lisa", fileName: "a.bin" });

		const res = await call(
			env,
			jsonRequest(
				`${BASE}/api/upload/complete`,
				{ dropId: "drop-nokey", uploadId: "upload-1" },
				{ Authorization: "Bearer ad_writer" },
			),
		);

		expect(res.status).toBe(200);
		for (const url of s3Urls) expect(url).toContain("drops/lisa/drop-nokey/uploads/a.bin");
	});

	test("falls back to r2_prefix + slugified subject for pre-0008 rows", async () => {
		// Rows created before migration 0008 (an upload already in flight across
		// the deploy) carry no object_key. The reconstruction still uses only
		// server-side columns -- never the request body.
		const env = makeEnv();
		await seedApiKey(env, "ad_writer", { permissions: "write" });
		await seedPendingDrop(env, {
			id: "drop-legacy",
			inbox: "lisa",
			fileName: "Z Profile.jpg",
			objectKey: null,
		});

		const res = await call(
			env,
			jsonRequest(
				`${BASE}/api/upload/complete`,
				{ dropId: "drop-legacy", uploadId: "upload-1", objectKey: "drops/evil/x" },
				{ Authorization: "Bearer ad_writer" },
			),
		);

		expect(res.status).toBe(200);
		for (const url of s3Urls) expect(url).toContain("drops/lisa/drop-legacy/uploads/z-profile.jpg");
	});
});
