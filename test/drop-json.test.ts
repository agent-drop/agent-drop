import { describe, expect, test } from "bun:test";
import { handleDrop, MAX_DIRECT_JSON_BYTES } from "../src/api/drop";
import { makeEnv } from "./helpers/env";

const URL_STRING = "https://drop.test/api/drop/lisa";

function post(body: BodyInit, env = makeEnv(), headers: Record<string, string> = {}) {
	const request = new Request(URL_STRING, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body,
	});
	return handleDrop(request, env, "lisa", new URL(request.url), { authMethod: "api_key" });
}

function dropCount(env: ReturnType<typeof makeEnv>): number {
	return (env.DB.raw.query("SELECT COUNT(*) AS n FROM drops").get() as { n: number }).n;
}

// The multipart branch of POST /api/drop got a byte budget; the JSON branch
// kept a bare request.json(): unbounded, and a malformed body was an unhandled
// throw instead of a 400.
describe("JSON drop body", () => {
	test("a normal JSON drop still lands", async () => {
		const env = makeEnv();
		const res = await post(JSON.stringify({ subject: "Hi", text: "Hello", topic: "t" }), env);
		expect(res.status).toBe(201);
		expect(env.DB.raw.query("SELECT subject, body_text, topic FROM drops").get()).toMatchObject({
			subject: "Hi",
			body_text: "Hello",
			topic: "t",
		});
	});

	test("malformed JSON is a 400 and writes nothing", async () => {
		const env = makeEnv();
		const res = await post("{not json", env);
		expect(res.status).toBe(400);
		expect(dropCount(env)).toBe(0);
	});

	test("a JSON value that is not an object is a 400", async () => {
		const env = makeEnv();
		expect((await post("[1,2]", env)).status).toBe(400);
		expect((await post("null", env)).status).toBe(400);
		expect(dropCount(env)).toBe(0);
	});

	test("a non-string field is a 400, not whatever D1 makes of it", async () => {
		const env = makeEnv();
		const res = await post(JSON.stringify({ subject: { $gt: 1 }, text: "x" }), env);
		expect(res.status).toBe(400);
		expect(dropCount(env)).toBe(0);
	});

	test("a declared body over the cap is a 413 before it is read", async () => {
		const env = makeEnv();
		const res = await post("{}", env, { "Content-Length": String(MAX_DIRECT_JSON_BYTES + 1) });
		expect(res.status).toBe(413);
		expect(dropCount(env)).toBe(0);
	});

	test("an undeclared (streamed) body over the cap is a 413", async () => {
		const env = makeEnv();
		const big = JSON.stringify({ text: "x".repeat(MAX_DIRECT_JSON_BYTES) });
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(big));
				controller.close();
			},
		});
		const res = await post(stream, env);
		expect(res.status).toBe(413);
		expect(dropCount(env)).toBe(0);
	});
});
