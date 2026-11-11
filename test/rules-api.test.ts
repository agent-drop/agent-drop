import { describe, expect, test } from "bun:test";
import { handleRules } from "../src/api/rules";
import { makeEnv, type TestEnv } from "./helpers/env";

/**
 * A relay rule's `target` is the mask OWNER: where relayed mail goes, and the
 * one mailbox `relayReplyRefusal` lets reply as the mask. It must be exactly one
 * bare address. A list or a display-name form would be stored, then misread on
 * both legs.
 */

function call(env: TestEnv, method: string, path: string, body: unknown): Promise<Response> {
	const url = new URL(`https://example.com${path}`);
	const request = new Request(url, {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return handleRules(request, env, url);
}

async function create(env: TestEnv, body: Record<string, unknown>): Promise<Response> {
	return call(env, "POST", "/api/rules", { pattern: "j-*", scopes: "email", ...body });
}

async function storedTargets(env: TestEnv): Promise<string[]> {
	const rows = env.DB.raw.query("SELECT target FROM drop_rules").all() as { target: string }[];
	return rows.map((row) => row.target);
}

describe("POST /api/rules: relay target", () => {
	test("a single bare address is accepted", async () => {
		const env = makeEnv();
		const res = await create(env, { type: "relay", target: "owner@example.org" });
		expect(res.status).toBe(201);
		expect(await storedTargets(env)).toEqual(["owner@example.org"]);
	});

	test("surrounding whitespace is trimmed, not stored", async () => {
		const env = makeEnv();
		const res = await create(env, { type: "relay", target: "  owner@example.org " });
		expect(res.status).toBe(201);
		expect(await storedTargets(env)).toEqual(["owner@example.org"]);
	});

	for (const target of [
		"a@example.org, b@example.org",
		"a@example.org;b@example.org",
		'"Owner" <owner@example.org>',
		"<owner@example.org>",
		"owner",
		"owner@",
		"owner@example.org\r\nBcc: x@evil.test",
	]) {
		test(`refuses ${JSON.stringify(target)}`, async () => {
			const env = makeEnv();
			const res = await create(env, { type: "relay", target });
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).toContain("relay target");
			expect(await storedTargets(env)).toEqual([]);
		});
	}

	test("a forward rule keeps its comma-separated list", async () => {
		const env = makeEnv();
		const res = await create(env, { type: "forward", target: "a@example.org, b@example.org" });
		expect(res.status).toBe(201);
	});
});

describe("PATCH /api/rules/:id: relay target", () => {
	async function relayRule(env: TestEnv): Promise<string> {
		const res = await create(env, { type: "relay", target: "owner@example.org" });
		return ((await res.json()) as { id: string }).id;
	}

	test("a new bare address is accepted", async () => {
		const env = makeEnv();
		const id = await relayRule(env);
		const res = await call(env, "PATCH", `/api/rules/${id}`, { target: "new@example.org" });
		expect(res.status).toBe(200);
		expect(await storedTargets(env)).toEqual(["new@example.org"]);
	});

	test("a list is refused and the stored owner is unchanged", async () => {
		const env = makeEnv();
		const id = await relayRule(env);
		const res = await call(env, "PATCH", `/api/rules/${id}`, {
			target: "new@example.org, evil@example.test",
		});
		expect(res.status).toBe(400);
		expect(await storedTargets(env)).toEqual(["owner@example.org"]);
	});

	test("a forward rule's target may still become a list", async () => {
		const env = makeEnv();
		const res = await create(env, { type: "forward", target: "a@example.org" });
		const { id } = (await res.json()) as { id: string };
		const patched = await call(env, "PATCH", `/api/rules/${id}`, {
			target: "a@example.org, b@example.org",
		});
		expect(patched.status).toBe(200);
	});
});
