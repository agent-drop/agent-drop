/**
 * REGRESSION: outbound mail ignored the API key's `inbox_scope`.
 *
 * `POST /api/send/:inbox`, `/api/compose/:inbox` and `/api/send/presign/:inbox`
 * checked that the key carried write permission and stopped there. Every other
 * write path -- `/api/drop`, the presigned upload routes, hosting -- also checks
 * that the box is the one the key was issued for.
 *
 * The `:inbox` in these routes becomes the FROM address: `handleSend` sends as
 * `{inbox}@{DOMAIN}` and signs it with the domain's DKIM. So a key issued
 * "write, scoped to bob" could send mail as lisa@ -- a scoped credential
 * spoofing any identity the domain owns, which is most of the point of scoping
 * it in the first place.
 *
 * Found during the phase-6 router rewrite: the write-scope check had been
 * pasted inline at four call sites and these three had a copy that stopped one
 * line early. RED before the fix (all three returned 200), green after.
 */

import { describe, expect, test } from "bun:test";
import { handleAPI } from "../src/api/router";
import type { Env } from "../src/types";
import { makeEmail } from "./helpers/email";
import { makeCtx, makeEnv, seedApiKey, TEST_DOMAIN, type TestEnv } from "./helpers/env";

const BASE = `https://${TEST_DOMAIN}`;

async function mailEnv(): Promise<TestEnv> {
	const env = makeEnv({ EMAIL: makeEmail() as unknown as Env["EMAIL"] });
	await seedApiKey(env, "ad_bob", { permissions: "write", inboxScope: "bob" });
	await seedApiKey(env, "ad_any", { permissions: "write", inboxScope: null });
	await seedApiKey(env, "ad_admin", { permissions: "admin", inboxScope: "bob" });
	return env;
}

function post(env: TestEnv, path: string, key: string, body: unknown) {
	const request = new Request(`${BASE}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
		body: JSON.stringify(body),
	});
	return handleAPI(request, env, new URL(request.url), makeCtx());
}

const MAIL = { to: "someone@example.com", subject: "Hi", text: "Hello" };

const ROUTES = [
	{ name: "send", path: (box: string) => `/api/send/${box}`, body: MAIL },
	{ name: "compose", path: (box: string) => `/api/compose/${box}`, body: MAIL },
	{
		name: "send/presign",
		path: (box: string) => `/api/send/presign/${box}`,
		body: { fileName: "a.zip" },
	},
] as const;

describe("outbound mail respects the key's inbox scope", () => {
	for (const route of ROUTES) {
		test(`${route.name} rejects a key scoped to another box`, async () => {
			const env = await mailEnv();
			const res = await post(env, route.path("lisa"), "ad_bob", route.body);
			expect(res.status).toBe(403);
			expect((await res.json()) as Record<string, unknown>).toEqual({
				error: "inbox not in scope",
			});
		});

		test(`${route.name} accepts the box the key is scoped to`, async () => {
			const env = await mailEnv();
			const res = await post(env, route.path("bob"), "ad_bob", route.body);
			expect(res.status).toBe(200);
		});

		test(`${route.name} accepts an unscoped key for any box`, async () => {
			const env = await mailEnv();
			const res = await post(env, route.path("lisa"), "ad_any", route.body);
			expect(res.status).toBe(200);
		});

		test(`${route.name} does not exempt an admin-permission key from its scope`, async () => {
			// `permissions: admin` says what the key may DO, not which boxes it may
			// do it to. The scope still binds -- same as every other write path.
			const env = await mailEnv();
			const res = await post(env, route.path("lisa"), "ad_admin", route.body);
			expect(res.status).toBe(403);
		});
	}

	test("no mail is actually sent when the scope check rejects", async () => {
		const email = makeEmail();
		const env = makeEnv({ EMAIL: email as unknown as Env["EMAIL"] });
		await seedApiKey(env, "ad_bob", { permissions: "write", inboxScope: "bob" });

		await post(env, "/api/send/lisa", "ad_bob", MAIL);

		expect(email.sends).toHaveLength(0);
	});

	test("the normalized box name is what gets compared, not the raw path segment", async () => {
		// `/api/send/Mr.Gray` normalizes to `mrgray`. A key scoped to `mrgray` must
		// pass; the check has to run AFTER normalization or every dotted address
		// would be rejected.
		const env = makeEnv({ EMAIL: makeEmail() as unknown as Env["EMAIL"] });
		await seedApiKey(env, "ad_gray", { permissions: "write", inboxScope: "mrgray" });

		expect((await post(env, "/api/send/Mr.Gray", "ad_gray", MAIL)).status).toBe(200);
		expect((await post(env, "/api/send/lisa", "ad_gray", MAIL)).status).toBe(403);
	});
});
