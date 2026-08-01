import { describe, expect, test } from "bun:test";
import { handleAPI } from "../src/api/router";
import { jsonRequest, makeCtx, makeEnv, seedApiKey, type TestEnv } from "./helpers/env";

const BASE = "https://drop.test";

function call(env: TestEnv, request: Request) {
	return handleAPI(request, env, new URL(request.url), makeCtx());
}

// REGRESSION (found while wiring the upload-finalize auth, 2026-08-01): the
// router's `authenticateWrite` checked that an API key was valid and carried the
// `write` permission, but never checked `inbox_scope`. Every read path did check
// it. So a key issued as "write, scoped to bob" could drop into ANY box --
// `/api/drop/lisa`, `/api/upload/presign/lisa`, `/api/upload/multipart/lisa` --
// which makes a scoped key an unscoped one for writes and silently defeats the
// point of ever issuing one.
describe("a scoped write key cannot write outside its scope", () => {
	const paths = ["/api/drop/lisa", "/api/upload/presign/lisa", "/api/upload/multipart/lisa"];

	for (const path of paths) {
		test(`${path} rejects a key scoped to another box`, async () => {
			const env = makeEnv();
			await seedApiKey(env, "ad_bob", { inboxScope: "bob", permissions: "write" });

			const res = await call(
				env,
				jsonRequest(
					BASE + path,
					{ fileName: "x.pdf", fileSize: 10 },
					{ Authorization: "Bearer ad_bob" },
				),
			);

			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({ error: "inbox not in scope" });

			const { results } = await env.DB.prepare("SELECT id FROM drops").bind().all();
			expect(results).toHaveLength(0);
		});
	}

	test("presign accepts the key scoped to its own box", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_lisa", { inboxScope: "lisa", permissions: "write" });

		const res = await call(
			env,
			jsonRequest(
				`${BASE}/api/upload/presign/lisa`,
				{ fileName: "x.pdf", fileSize: 10 },
				{ Authorization: "Bearer ad_lisa" },
			),
		);

		expect(res.status).toBe(200);
	});

	test("presign accepts an unscoped write key", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_any", { inboxScope: null, permissions: "write" });

		const res = await call(
			env,
			jsonRequest(
				`${BASE}/api/upload/presign/lisa`,
				{ fileName: "x.pdf", fileSize: 10 },
				{ Authorization: "Bearer ad_any" },
			),
		);

		expect(res.status).toBe(200);
	});
});
