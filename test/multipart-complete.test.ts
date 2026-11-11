import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleAPI } from "../src/api/router";
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
const WRITER = { Authorization: "Bearer ad_writer" };
const MiB = 1024 * 1024;

// 120 MiB plans as three parts: 50 + 50 + 20 MiB.
const FILE_SIZE = 120 * MiB;
const FULL: [number, number][] = [
	[1, 50 * MiB],
	[2, 50 * MiB],
	[3, 20 * MiB],
];

function call(env: TestEnv, request: Request) {
	return handleAPI(request, env, new URL(request.url), makeCtx());
}

/** A ListPartsResult carrying `[partNumber, size]` pairs; size null omits <Size>. */
function listing(parts: [number, number | null][]): string {
	const inner = parts
		.map(
			([n, size]) =>
				`<Part><PartNumber>${n}</PartNumber><ETag>&quot;e${n}&quot;</ETag>` +
				(size === null ? "" : `<Size>${size}</Size>`) +
				"</Part>",
		)
		.join("");
	return `<?xml version="1.0" encoding="UTF-8"?>
		<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${inner}</ListPartsResult>`;
}

// The S3 side: initiate, list, complete. `listed` is what ListParts answers;
// `completes` counts CompleteMultipartUpload calls, the one that must not happen
// for a partial upload.
const realFetch = globalThis.fetch;
let listed = listing(FULL);
let completes = 0;

beforeEach(() => {
	listed = listing(FULL);
	completes = 0;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(href);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		if (method === "POST" && url.searchParams.has("uploads")) {
			return new Response(
				"<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>",
			);
		}
		if (method === "GET") return new Response(listed);
		if (method === "POST" && url.searchParams.has("uploadId")) {
			completes++;
			return new Response("<CompleteMultipartUploadResult/>");
		}
		return new Response("unexpected R2 call", { status: 500 });
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

async function writerEnv(): Promise<TestEnv> {
	const env = makeEnv();
	await seedApiKey(env, "ad_writer", { permissions: "write" });
	return env;
}

/** Init through the real route, so the plan on the row is the one init wrote. */
async function initUpload(env: TestEnv): Promise<string> {
	const res = await call(
		env,
		jsonRequest(
			`${BASE}/api/upload/multipart/lisa`,
			{ fileName: "big.bin", fileSize: FILE_SIZE },
			WRITER,
		),
	);
	expect(res.status).toBe(200);
	const body = (await res.json()) as { dropId: string; parts: unknown[] };
	expect(body.parts).toHaveLength(3);
	return body.dropId;
}

function complete(env: TestEnv, dropId: string) {
	return call(
		env,
		jsonRequest(`${BASE}/api/upload/complete`, { dropId, uploadId: "up-1" }, WRITER),
	);
}

describe("multipart init records its plan on the drop row", () => {
	test("file size, part size, part count and URL expiry land in metadata", async () => {
		const env = await writerEnv();
		const before = Date.now();
		const dropId = await initUpload(env);

		const row = env.DB.raw.query("SELECT metadata FROM drops WHERE id = ?").get(dropId) as {
			metadata: string;
		};
		const metadata = JSON.parse(row.metadata);
		expect(metadata.multipart).toBe(true);
		expect(metadata.auth_method).toBe("api_key");
		expect(metadata.multipart_plan).toMatchObject({
			file_size: FILE_SIZE,
			part_size: 50 * MiB,
			part_count: 3,
		});
		// 120 MiB is under the one-hour floor.
		expect(metadata.multipart_plan.expires_at).toBeGreaterThanOrEqual(before + 3600_000);
	});
});

// REGRESSION: complete listed whatever parts R2 held and completed with them, so
// a client that called it early got a truncated object published as `completed`
// to every agent reading the box.
describe("POST /api/upload/complete checks the parts against the plan", () => {
	test("completes when every planned part is there and the bytes add up", async () => {
		const env = await writerEnv();
		const dropId = await initUpload(env);

		const res = await complete(env, dropId);

		expect(res.status).toBe(200);
		expect(completes).toBe(1);
		expect(dropStatus(env, dropId)).toBe("completed");
	});

	test("a missing middle part is a 409, R2 is never completed, and a retry works", async () => {
		const env = await writerEnv();
		const dropId = await initUpload(env);

		listed = listing([FULL[0], FULL[2]]);
		const res = await complete(env, dropId);

		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			expectedParts: 3,
			receivedParts: 2,
			missingParts: [2],
			expectedBytes: FILE_SIZE,
			receivedBytes: 70 * MiB,
		});
		expect(completes).toBe(0);
		expect(dropStatus(env, dropId)).toBe("pending");

		// Nothing was aborted: once the part lands, the same request completes.
		listed = listing(FULL);
		expect((await complete(env, dropId)).status).toBe(200);
		expect(completes).toBe(1);
		expect(dropStatus(env, dropId)).toBe("completed");
	});

	test("an upload that stopped early is refused", async () => {
		const env = await writerEnv();
		const dropId = await initUpload(env);

		listed = listing([FULL[0], FULL[1]]);
		const res = await complete(env, dropId);

		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ missingParts: [3] });
		expect(completes).toBe(0);
		expect(dropStatus(env, dropId)).toBe("pending");
	});

	test("no parts at all is refused, not a 500", async () => {
		const env = await writerEnv();
		const dropId = await initUpload(env);

		listed = listing([]);
		const res = await complete(env, dropId);

		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ missingParts: [1, 2, 3], receivedBytes: 0 });
		expect(completes).toBe(0);
	});

	test("the right part count with the wrong byte total is refused", async () => {
		const env = await writerEnv();
		const dropId = await initUpload(env);

		listed = listing([FULL[0], FULL[1], [3, 20 * MiB - 1]]);
		const res = await complete(env, dropId);

		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			missingParts: [],
			expectedBytes: FILE_SIZE,
			receivedBytes: FILE_SIZE - 1,
		});
		expect(completes).toBe(0);
		expect(dropStatus(env, dropId)).toBe("pending");
	});

	test("a part the plan never had is refused even when the bytes add up", async () => {
		const env = await writerEnv();
		const dropId = await initUpload(env);

		listed = listing([...FULL, [4, 0]]);
		const res = await complete(env, dropId);

		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ receivedParts: 4, receivedBytes: FILE_SIZE });
		expect(completes).toBe(0);
	});

	test("a listing without part sizes cannot be verified, so it is not completed", async () => {
		const env = await writerEnv();
		const dropId = await initUpload(env);

		listed = listing(FULL.map(([n]) => [n, null] as [number, null]));
		const res = await complete(env, dropId);

		expect(res.status).toBe(500);
		expect(completes).toBe(0);
		expect(dropStatus(env, dropId)).toBe("pending");
	});

	test("a row from before plans were recorded still completes as it always did", async () => {
		const env = await writerEnv();
		await seedPendingDrop(env, { id: "drop-old", inbox: "lisa", fileName: "big.bin" });

		// One part, no <Size>: exactly what the check would refuse on a planned row.
		listed = listing([[1, null]]);
		const res = await complete(env, "drop-old");

		expect(res.status).toBe(200);
		expect(completes).toBe(1);
		expect(dropStatus(env, "drop-old")).toBe("completed");
	});
});
