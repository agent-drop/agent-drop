import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleAPI } from "../src/api/router";
import { MAX_UPLOAD_INIT_BODY_BYTES } from "../src/api/upload";
import { makeCtx, makeEnv, seedApiKey, type TestEnv } from "./helpers/env";

const BASE = "https://drop.test";
const WRITER = { Authorization: "Bearer ad_writer" };

// R2 must never be reached by a request that should have been refused.
const realFetch = globalThis.fetch;
let r2Calls = 0;

beforeEach(() => {
	r2Calls = 0;
	globalThis.fetch = (async () => {
		r2Calls++;
		return new Response("unexpected R2 call", { status: 500 });
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

async function writerEnv(): Promise<TestEnv> {
	const env = makeEnv();
	await seedApiKey(env, "ad_writer", { permissions: "write" });
	return env;
}

function post(env: TestEnv, path: string, body: BodyInit, headers: Record<string, string> = {}) {
	const request = new Request(BASE + path, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...WRITER, ...headers },
		body,
	});
	return handleAPI(request, env, new URL(request.url), makeCtx());
}

async function errorOf(res: Response): Promise<string> {
	return ((await res.json()) as { error: string }).error;
}

function dropCount(env: TestEnv): number {
	return (env.DB.raw.query("SELECT COUNT(*) AS n FROM drops").get() as { n: number }).n;
}

// REGRESSION: both init routes called request.json() uncaught and handed
// `fileName` to slugifyFilename unchecked, so malformed JSON or a fileName that
// was a number threw out of the handler as a 500, unbounded in size.
for (const path of ["/api/upload/presign/lisa", "/api/upload/multipart/lisa"]) {
	describe(`${path} validates its body`, () => {
		const valid = { fileName: "a.bin", fileSize: 200 * 1024 * 1024 };

		test("malformed JSON is a 400", async () => {
			const env = await writerEnv();
			expect((await post(env, path, "{oops")).status).toBe(400);
			expect(r2Calls).toBe(0);
			expect(dropCount(env)).toBe(0);
		});

		test("JSON that is not an object is a 400", async () => {
			const env = await writerEnv();
			for (const body of ["[]", "null", '"a.bin"', "42"]) {
				expect((await post(env, path, body)).status).toBe(400);
			}
			expect(r2Calls).toBe(0);
			expect(dropCount(env)).toBe(0);
		});

		test("a fileName that is not a non-empty string is a 400", async () => {
			const env = await writerEnv();
			for (const fileName of [42, { a: 1 }, ["a.bin"], true, "", null]) {
				const res = await post(env, path, JSON.stringify({ ...valid, fileName }));
				expect(res.status).toBe(400);
				expect(await errorOf(res)).toBe("fileName required");
			}
			expect(r2Calls).toBe(0);
			expect(dropCount(env)).toBe(0);
		});

		test("a contentType or topic that is not a string is a 400", async () => {
			const env = await writerEnv();
			for (const extra of [{ contentType: 5 }, { topic: ["x"] }, { topic: { a: 1 } }]) {
				const res = await post(env, path, JSON.stringify({ ...valid, ...extra }));
				expect(res.status).toBe(400);
				const field = Object.keys(extra)[0];
				expect(await errorOf(res)).toBe(`${field} must be a string`);
			}
			expect(r2Calls).toBe(0);
			expect(dropCount(env)).toBe(0);
		});

		test("a declared body over the cap is a 413", async () => {
			const env = await writerEnv();
			const res = await post(env, path, JSON.stringify(valid), {
				"Content-Length": String(MAX_UPLOAD_INIT_BODY_BYTES + 1),
			});
			expect(res.status).toBe(413);
			expect(r2Calls).toBe(0);
		});

		test("a streamed body over the cap is a 413", async () => {
			const env = await writerEnv();
			const big = JSON.stringify({ ...valid, pad: "a".repeat(MAX_UPLOAD_INIT_BODY_BYTES) });
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(big));
					controller.close();
				},
			});
			expect((await post(env, path, stream)).status).toBe(413);
			expect(r2Calls).toBe(0);
			expect(dropCount(env)).toBe(0);
		});
	});
}
