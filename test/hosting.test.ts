import { beforeEach, describe, expect, test } from "bun:test";
import { normalizeSite, sanitizeSitePath, serveHostedSite, siteUrl } from "../src/lib/hosting";
import { makeBucket, makeEnv, TEST_DOMAIN, type TestEnv } from "./helpers/env";

// Hosted sites are the only PUBLIC read surface in the system: no auth, served
// straight out of R2 under {domain}/f/{box}/{site}/. The path built here is an
// R2 key, so anything that survives sanitization is a key another box could own.

describe("normalizeSite", () => {
	test("lowercases and kebabs", () => {
		expect(normalizeSite("Marketing")).toBe("marketing");
		expect(normalizeSite("my_site")).toBe("my-site");
		expect(normalizeSite("my site")).toBe("my-site");
		expect(normalizeSite("  spaced  ")).toBe("spaced");
	});

	test("allows a leading digit, unlike inbox names", () => {
		expect(normalizeSite("2024-launch")).toBe("2024-launch");
	});

	test("strips characters outside a-z 0-9 hyphen", () => {
		expect(normalizeSite("pro!mo#1")).toBe("promo1");
		expect(normalizeSite("café")).toBe("caf");
	});

	test("collapses and trims hyphens", () => {
		expect(normalizeSite("a---b")).toBe("a-b");
		expect(normalizeSite("-promo-")).toBe("promo");
	});

	test("rejects empty and over-long names", () => {
		expect(normalizeSite("")).toBeNull();
		expect(normalizeSite("!!!")).toBeNull();
		expect(normalizeSite("---")).toBeNull();
		expect(normalizeSite("a".repeat(64))).toBe("a".repeat(64));
		expect(normalizeSite("a".repeat(65))).toBeNull();
	});

	test("cannot express a path segment", () => {
		expect(normalizeSite("../../secret")).toBe("secret");
		expect(normalizeSite("a/b")).toBe("ab");
		expect(normalizeSite("..")).toBeNull();
	});

	test("is idempotent", () => {
		for (const raw of ["Marketing", "my_site", "-promo-", "a---b", "2024 Launch"]) {
			const once = normalizeSite(raw);
			expect(once).not.toBeNull();
			expect(normalizeSite(once as string)).toBe(once as string);
		}
	});
});

describe("sanitizeSitePath", () => {
	test("preserves structure and case so authored links resolve", () => {
		expect(sanitizeSitePath("assets/App.CSS")).toBe("assets/App.CSS");
		expect(sanitizeSitePath("index.html")).toBe("index.html");
	});

	test("drops . and .. segments", () => {
		expect(sanitizeSitePath("../../etc/passwd")).toBe("etc/passwd");
		expect(sanitizeSitePath("a/../b")).toBe("a/b");
		expect(sanitizeSitePath("./a/./b")).toBe("a/b");
		expect(sanitizeSitePath("..")).toBe("");
		expect(sanitizeSitePath("../..")).toBe("");
	});

	test("drops empty segments, so a leading or doubled slash cannot re-root", () => {
		expect(sanitizeSitePath("/abs/path")).toBe("abs/path");
		expect(sanitizeSitePath("a//b")).toBe("a/b");
		expect(sanitizeSitePath("///")).toBe("");
	});

	test("trims whitespace-only segments", () => {
		expect(sanitizeSitePath("a/  /b")).toBe("a/b");
		expect(sanitizeSitePath(" a / b ")).toBe("a/b");
	});

	test("output never contains a traversal segment", () => {
		for (const raw of ["../../x", "a/../../b", "./../c", "//..//d", "  ..  /e"]) {
			const segs = sanitizeSitePath(raw).split("/").filter(Boolean);
			expect(segs).not.toContain("..");
			expect(segs).not.toContain(".");
		}
	});
});

describe("siteUrl", () => {
	test("builds the public URL with a trailing slash", () => {
		expect(siteUrl(makeEnv(), "lisa", "marketing")).toBe(
			`https://${TEST_DOMAIN}/f/lisa/marketing/`,
		);
	});
});

describe("serveHostedSite", () => {
	let env: TestEnv;

	const FILES = {
		"sites/lisa/marketing/index.html": "<h1>root</h1>",
		"sites/lisa/marketing/style.css": "body{}",
		"sites/lisa/marketing/docs/index.html": "<h1>docs</h1>",
		"sites/bob/private/index.html": "<h1>bob</h1>",
		"sites/lisa/expired/index.html": "<h1>gone</h1>",
		"sites/lisa/locked/index.html": "<h1>locked</h1>",
		"secret/not-a-site.txt": "should never be reachable",
	};

	async function seedSite(
		inbox: string,
		site: string,
		opts: { authToken?: string | null; expiresAt?: number | null } = {},
	) {
		await env.DB.prepare(
			`INSERT INTO hosted_sites (id, inbox, site, file_count, total_bytes, auth_token, created_at, updated_at, expires_at)
			VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?)`,
		)
			.bind(
				crypto.randomUUID(),
				inbox,
				site,
				opts.authToken ?? null,
				Date.now(),
				Date.now(),
				opts.expiresAt ?? null,
			)
			.run();
	}

	function get(path: string, method = "GET") {
		const url = new URL(`https://${TEST_DOMAIN}${path}`);
		return serveHostedSite(new Request(url, { method }), env, url);
	}

	beforeEach(async () => {
		env = makeEnv({ BUCKET: makeBucket(FILES) });
		await seedSite("lisa", "marketing");
		await seedSite("bob", "private");
		await seedSite("lisa", "expired", { expiresAt: Date.now() - 1000 });
		await seedSite("lisa", "locked", { authToken: "s3cr3t" });
	});

	test("serves index.html at the site root", async () => {
		const res = await get("/f/lisa/marketing/");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("<h1>root</h1>");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	// Hosted files are attacker-supplied and share a host with the SPA, which
	// keeps credentials in localStorage. `sandbox` without `allow-same-origin`
	// is what denies an uploaded page access to them.
	test("serves hosted files into an opaque origin", async () => {
		const csp = (await get("/f/lisa/marketing/")).headers.get("Content-Security-Policy");
		expect(csp).toContain("sandbox");
		expect(csp).not.toContain("allow-same-origin");
	});

	test("redirects the no-slash root to the slashed form so relative links resolve", async () => {
		const res = await get("/f/lisa/marketing");
		expect(res.status).toBe(301);
		expect(res.headers.get("location")).toBe(`https://${TEST_DOMAIN}/f/lisa/marketing/`);
	});

	test("serves a nested file and infers its content type", async () => {
		const res = await get("/f/lisa/marketing/style.css");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
		expect(await res.text()).toBe("body{}");
	});

	test("falls back to index.html for a directory-style path", async () => {
		expect(await (await get("/f/lisa/marketing/docs/")).text()).toBe("<h1>docs</h1>");
		// Also without the trailing slash, since the key has no extension.
		expect(await (await get("/f/lisa/marketing/docs")).text()).toBe("<h1>docs</h1>");
	});

	test("HEAD returns the headers with no body", async () => {
		const res = await get("/f/lisa/marketing/style.css", "HEAD");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
		expect(await res.text()).toBe("");
	});

	test("404s a missing file inside a real site", async () => {
		expect((await get("/f/lisa/marketing/nope.png")).status).toBe(404);
	});

	test("404s an unregistered site even when R2 objects exist under its prefix", async () => {
		// The registry, not R2, decides what is public.
		env = makeEnv({ BUCKET: makeBucket(FILES) });
		expect((await get("/f/lisa/marketing/")).status).toBe(404);
	});

	test("410s a site past its TTL", async () => {
		expect((await get("/f/lisa/expired/")).status).toBe(410);
	});

	test("401s a private site without the token, 200s with it", async () => {
		expect((await get("/f/lisa/locked/")).status).toBe(401);
		expect((await get("/f/lisa/locked/?auth=wrong")).status).toBe(401);
		expect((await get("/f/lisa/locked/?auth=s3cr3t")).status).toBe(200);
	});

	test("redirects to the app when box or site is missing from the path", async () => {
		for (const path of ["/f", "/f/", "/f/lisa", "/f/lisa/"]) {
			const res = await get(path);
			expect(res.status).toBe(302);
			expect(res.headers.get("location")).toBe(`https://${TEST_DOMAIN}/`);
		}
	});

	test("dot segments never survive to the worker, encoded or not", async () => {
		// WHATWG URL collapses "." and ".." including their percent-encoded forms,
		// so serveHostedSite's own filter on those segments is defense in depth
		// that a real Request can no longer trigger. Pinned here so that stays
		// true; the filter's logic itself is covered by the sanitizeSitePath tests.
		expect(new URL(`https://${TEST_DOMAIN}/f/a/b/../c`).pathname).toBe("/f/a/c");
		expect(new URL(`https://${TEST_DOMAIN}/f/a/b/%2e%2e/c`).pathname).toBe("/f/a/c");
		expect(new URL(`https://${TEST_DOMAIN}/f/a/%2e/b`).pathname).toBe("/f/a/b");
	});

	test("the R2 key is always rebuilt under sites/{box}/{site}", async () => {
		// secret/not-a-site.txt is in the bucket, but no /f/ path can name it:
		// segs[1] and segs[2] are forced through normalizeInbox/normalizeSite and
		// the key is composed as `sites/${inbox}/${site}/...`.
		expect((await get("/f/secret/not-a-site.txt")).status).toBe(404);
		expect((await get("/f/secret/not-a-site/txt")).status).toBe(404);
		expect((await get("/f/lisa/marketing/secret/not-a-site.txt")).status).toBe(404);
	});

	test("a path that resolves into another box only reaches REGISTERED sites", async () => {
		// After URL normalization this IS /f/bob/private/index.html, and it is
		// served -- correctly -- because bob/private is a registered public site.
		// The registry is the gate, not the shape of the path.
		expect((await get("/f/lisa/marketing/../../bob/private/index.html")).status).toBe(200);
		// normalizeInbox("../bob") is "bob", so this is just an alias for the same
		// public site.
		expect((await get("/f/..%2Fbob/private/index.html")).status).toBe(200);
		// But no registry row exists for lisa/bobprivate, so the R2 object at
		// sites/bob/private/index.html stays unreachable through lisa.
		expect((await get("/f/lisa/..%2F..%2Fbob%2Fprivate/index.html")).status).toBe(404);
	});

	test("the box segment is normalized like any inbox name", async () => {
		// "Li.sa" -> "lisa", so the gmail-style collapse applies to hosting too.
		expect((await get("/f/Li.sa/Marketing/")).status).toBe(200);
	});
});
