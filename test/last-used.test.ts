import { describe, expect, test } from "bun:test";
import { handleAPI } from "../src/api/router";
import { validateApiKey } from "../src/lib/auth";
import {
	gateStatement,
	makeCtx,
	makeEnv,
	seedApiKey,
	sha256Hex,
	type TestEnv,
} from "./helpers/env";

const BASE = "https://drop.test";

function lastUsed(env: TestEnv, keyHash: string): number | null {
	const row = env.DB.raw
		.query("SELECT last_used_at FROM api_keys WHERE key_hash = ?")
		.get(keyHash) as { last_used_at: number | null } | undefined;
	return row?.last_used_at ?? null;
}

// `validateApiKey` awaited `UPDATE api_keys SET last_used_at = ?` on every
// authenticated request, so every read carried a serialized D1 write before it
// could answer. The write still happens -- it is just deferred past the
// response. These tests pin both halves: it is NOT done inline, and it IS done.
describe("last_used_at is written off the critical path", () => {
	test("with a ctx, the update lands only after the deferred work settles", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_reader", { permissions: "read" });
		const keyHash = await sha256Hex("ad_reader");
		const gate = gateStatement(env, "UPDATE api_keys SET last_used_at");
		const ctx = makeCtx();

		const auth = await validateApiKey(
			env,
			new Request(BASE, { headers: { Authorization: "Bearer ad_reader" } }),
			ctx,
		);

		// The call has returned while the UPDATE is still gated. An inline `await`
		// could not have got here.
		expect(auth.valid).toBe(true);
		expect(lastUsed(env, keyHash)).toBeNull();
		expect(ctx.waits).toHaveLength(1);

		gate.release();
		await ctx.settle();
		expect(lastUsed(env, keyHash)).toBeGreaterThan(0);
	});

	test("without a ctx it still writes, inline", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_reader", { permissions: "read" });
		const keyHash = await sha256Hex("ad_reader");

		await validateApiKey(
			env,
			new Request(BASE, { headers: { Authorization: "Bearer ad_reader" } }),
		);

		expect(lastUsed(env, keyHash)).toBeGreaterThan(0);
	});

	test("the router threads its ctx through, so a read path defers the write", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_reader", { permissions: "read" });
		const keyHash = await sha256Hex("ad_reader");
		const gate = gateStatement(env, "UPDATE api_keys SET last_used_at");
		const ctx = makeCtx();

		const req = new Request(`${BASE}/api/inbox/lisa`, {
			headers: { Authorization: "Bearer ad_reader" },
		});
		const res = await handleAPI(req, env, new URL(req.url), ctx);

		// The whole request answered without the bookkeeping write having run.
		expect(res.status).toBe(200);
		expect(lastUsed(env, keyHash)).toBeNull();

		gate.release();
		await ctx.settle();
		expect(lastUsed(env, keyHash)).toBeGreaterThan(0);
	});

	test("a failed bookkeeping write does not fail the request", async () => {
		const env = makeEnv();
		await seedApiKey(env, "ad_reader", { permissions: "read" });
		const realPrepare = env.DB.prepare.bind(env.DB);
		env.DB.prepare = ((sql: string) => {
			if (sql.startsWith("UPDATE api_keys SET last_used_at")) {
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

		const ctx = makeCtx();
		const req = new Request(`${BASE}/api/inbox/lisa`, {
			headers: { Authorization: "Bearer ad_reader" },
		});
		const res = await handleAPI(req, env, new URL(req.url), ctx);

		expect(res.status).toBe(200);
		// settle() must not reject either -- an unhandled rejection inside
		// waitUntil is what the .catch() in validateApiKey exists to prevent.
		await ctx.settle();
	});
});
