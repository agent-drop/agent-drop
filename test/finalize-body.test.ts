import { describe, expect, test } from "bun:test";
import { MAX_FINALIZE_BODY_BYTES } from "../src/api/gates";
import { handleAPI } from "../src/api/router";
import { makeCtx, makeEnv } from "./helpers/env";

const BASE = "https://drop.test";

function post(path: string, body: BodyInit, headers: Record<string, string> = {}) {
	const request = new Request(BASE + path, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body,
	});
	return handleAPI(request, makeEnv(), new URL(request.url), makeCtx());
}

// /api/upload/confirm and /complete look the drop up by id BEFORE any
// credential is checked (the inbox comes from the row). Their body was read
// with request.json(), unbounded: an anonymous caller could make the Worker
// buffer a 100 MB body just to be told 404.
describe("finalize routes bound the body before auth", () => {
	for (const path of ["/api/upload/confirm", "/api/upload/complete"]) {
		test(`${path}: a declared body over the cap is a 413`, async () => {
			const res = await post(path, '{"dropId":"x"}', {
				"Content-Length": String(MAX_FINALIZE_BODY_BYTES + 1),
			});
			expect(res.status).toBe(413);
		});

		test(`${path}: a streamed body over the cap is a 413`, async () => {
			const big = JSON.stringify({ dropId: "nope", pad: "a".repeat(MAX_FINALIZE_BODY_BYTES) });
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(big));
					controller.close();
				},
			});
			expect((await post(path, stream)).status).toBe(413);
		});

		test(`${path}: a normal body still reaches the drop lookup`, async () => {
			const res = await post(path, JSON.stringify({ dropId: "missing", uploadId: "u" }));
			expect(res.status).toBe(404);
		});

		test(`${path}: malformed JSON is still a 400`, async () => {
			expect((await post(path, "{nope")).status).toBe(400);
		});
	}
});
