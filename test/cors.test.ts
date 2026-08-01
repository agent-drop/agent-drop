import { describe, expect, test } from "bun:test";
import { handleAPI } from "../src/api/router";
import { makeCtx, makeEnv, seedApiKey, TEST_ADMIN_KEY, TEST_DOMAIN, type TestEnv } from "./helpers/env";

const BASE = "https://drop.test";
const ORIGIN = `https://${TEST_DOMAIN}`;

function call(env: TestEnv, path: string, init: RequestInit = {}) {
	const request = new Request(BASE + path, {
		headers: { "CF-Connecting-IP": "203.0.113.7" },
		...init,
	});
	return handleAPI(request, env, new URL(request.url), makeCtx());
}

function acao(res: Response): string | null {
	return res.headers.get("Access-Control-Allow-Origin");
}

// REGRESSION: `corsHeaders` was a single object with
// `Access-Control-Allow-Origin: *` bolted onto EVERY response the API produced,
// admin routes included. Any page on the internet could read `/api/keys`,
// `/api/users` or `/api/drops` out of a visitor's browser as long as it could
// get hold of a credential -- and `*` also advertises the whole admin surface.
describe("CORS is scoped to the routes a browser actually calls", () => {
	test("admin routes carry no CORS headers, authenticated or not", async () => {
		const env = makeEnv();
		for (const path of ["/api/keys", "/api/users", "/api/targets", "/api/rules", "/api/masks"]) {
			const denied = await call(env, path);
			expect(denied.status).toBe(403);
			expect(acao(denied)).toBeNull();

			const allowed = await call(env, path, {
				headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}`, "CF-Connecting-IP": "203.0.113.7" },
			});
			expect(acao(allowed)).toBeNull();
		}
	});

	test("admin listing routes carry no CORS headers", async () => {
		const env = makeEnv();
		for (const path of ["/api/drops", "/api/boxes"]) {
			const res = await call(env, path, {
				headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}`, "CF-Connecting-IP": "203.0.113.7" },
			});
			expect(res.status).toBe(200);
			expect(acao(res)).toBeNull();
		}
	});

	test("browser-facing routes name the real origin instead of a wildcard", async () => {
		const env = makeEnv();
		for (const path of ["/api/health", "/api/config"]) {
			const res = await call(env, path);
			expect(res.status).toBe(200);
			expect(acao(res)).toBe(ORIGIN);
		}
	});

	test("upload and drop routes name the real origin, even when rejecting", async () => {
		const env = makeEnv();
		const drop = await call(env, "/api/drop/lisa", { method: "POST" });
		expect(acao(drop)).toBe(ORIGIN);

		const upload = await call(env, "/api/upload/confirm", {
			method: "POST",
			headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
			body: JSON.stringify({ dropId: "nope" }),
		});
		expect(acao(upload)).toBe(ORIGIN);
	});

	test("agent/CLI routes carry no CORS headers", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_reader", { permissions: "read" });
		const res = await call(env, "/api/inbox/lisa", {
			headers: { Authorization: "Bearer ad_reader", "CF-Connecting-IP": "203.0.113.7" },
		});
		expect(acao(res)).toBeNull();
	});

	test("preflight only succeeds for browser-facing routes", async () => {
		const env = makeEnv();
		const allowed = await call(env, "/api/upload/presign/lisa", { method: "OPTIONS" });
		expect(acao(allowed)).toBe(ORIGIN);
		expect(allowed.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");

		const denied = await call(env, "/api/keys", { method: "OPTIONS" });
		expect(acao(denied)).toBeNull();
	});

	test("no response anywhere carries a wildcard origin", async () => {
		const env = makeEnv();
		const paths = [
			"/api/health",
			"/api/config",
			"/api/keys",
			"/api/users",
			"/api/drops",
			"/api/boxes",
			"/api/inbox/lisa",
			"/api/nope",
		];
		for (const path of paths) {
			const res = await call(env, path, {
				headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}`, "CF-Connecting-IP": "203.0.113.7" },
			});
			expect(acao(res)).not.toBe("*");
		}
	});
});
