import { beforeEach, describe, expect, test } from "bun:test";
import worker from "../src/index";
import {
	makeBucket,
	makeCtx,
	makeEnv,
	TEST_DOMAIN,
	TEST_HOST_DOMAIN,
	type TestEnv,
} from "./helpers/env";

describe("hosted-content origin isolation", () => {
	let assetRequests: string[];
	let env: TestEnv;

	beforeEach(async () => {
		assetRequests = [];
		env = makeEnv({
			ASSETS: {
				fetch: async (request: Request) => {
					assetRequests.push(request.url);
					return new Response("application asset");
				},
			} as Fetcher,
			BUCKET: makeBucket({ "sites/lisa/report/index.html": "<script>site()</script>" }),
		});
		await env.DB.prepare(
			`INSERT INTO hosted_sites
				(id, inbox, site, file_count, total_bytes, auth_token, created_at, updated_at, expires_at)
			 VALUES (?, ?, ?, 1, 21, NULL, ?, ?, NULL)`,
		)
			.bind("site-1", "lisa", "report", Date.now(), Date.now())
			.run();
	});

	function fetch(host: string, path: string, init?: RequestInit) {
		return worker.fetch(new Request(`https://${host}${path}`, init), env, makeCtx());
	}

	test("serves uploaded content only on HOST_DOMAIN", async () => {
		const res = await fetch(TEST_HOST_DOMAIN, "/f/lisa/report/");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("<script>site()</script>");
		expect(assetRequests).toEqual([]);
	});

	test("redirects legacy application-origin links with path and query intact", async () => {
		const res = await fetch(TEST_DOMAIN, "/f/lisa/report/?auth=a%2Bb&next=%2Fdocs");
		expect(res.status).toBe(301);
		expect(res.headers.get("Location")).toBe(
			`https://${TEST_HOST_DOMAIN}/f/lisa/report/?auth=a%2Bb&next=%2Fdocs`,
		);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(assetRequests).toEqual([]);
	});

	test.each(["/", "/api/boxes", "/h/lisa/provider", "/assets/app.js"])(
		"does not expose the application surface at %s on HOST_DOMAIN",
		async (path) => {
			const res = await fetch(TEST_HOST_DOMAIN, path);
			expect(res.status).toBe(404);
			expect(await res.text()).toBe("Not found");
			expect(assetRequests).toEqual([]);
		},
	);

	test("does not accept mutation methods on either hosting origin", async () => {
		for (const host of [TEST_DOMAIN, TEST_HOST_DOMAIN]) {
			const res = await fetch(host, "/f/lisa/report/", { method: "POST" });
			expect(res.status).toBe(404);
		}
		expect(assetRequests).toEqual([]);
	});

	test("fails closed when HOST_DOMAIN is missing or shares the application origin", async () => {
		for (const HOST_DOMAIN of ["", TEST_DOMAIN]) {
			const misconfigured = makeEnv({ HOST_DOMAIN });
			const res = await worker.fetch(
				new Request(`https://${TEST_DOMAIN}/f/lisa/report/`),
				misconfigured,
				makeCtx(),
			);
			expect(res.status).toBe(503);
			expect(await res.text()).toBe("Hosting origin misconfigured");
		}
	});

	test("continues to delegate ordinary application requests to ASSETS", async () => {
		const res = await fetch(TEST_DOMAIN, "/dashboard");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("application asset");
		expect(assetRequests).toEqual([`https://${TEST_DOMAIN}/dashboard`]);
	});
});
