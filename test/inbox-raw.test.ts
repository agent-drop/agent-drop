import { describe, expect, test } from "bun:test";
import { handleAPI } from "../src/api/router";
import { makeBucket, makeCtx, makeEnv, seedApiKey, type TestEnv } from "./helpers/env";

const BASE = "https://drop.test";
const RAW = "Authentication-Results: mx.cloudflare.net; spf=pass\r\nSubject: hi\r\n\r\nbody\r\n";

function get(env: TestEnv, path: string) {
	const req = new Request(BASE + path, { headers: { Authorization: "Bearer ad_r" } });
	return handleAPI(req, env, new URL(req.url), makeCtx());
}

async function seedEmailDrop(env: TestEnv, id: string, inbox: string, raw: boolean) {
	const prefix = `drops/${inbox}/${id}`;
	await env.DB.prepare(
		`INSERT INTO drops (id, inbox, channel, subject, has_attachments, attachment_count,
			r2_prefix, raw_r2_key, metadata, status, created_at)
		VALUES (?, ?, ?, 'hi', 0, 0, ?, ?, '{}', 'completed', ?)`,
	)
		.bind(id, inbox, raw ? "email" : "web", prefix, raw ? `${prefix}/raw.eml` : null, Date.now())
		.run();
}

// The email handler stores the original message at `{r2_prefix}/raw.eml`, not
// under attachments/ or uploads/, so the generic file route can never find it.
// `drop raw` used to ask the file route for it and got a 404 on every email.
describe("GET /api/inbox/:name/:id/raw", () => {
	test("serves the stored original message byte for byte", async () => {
		const env = makeEnv({ BUCKET: makeBucket({ "drops/lisa/e1/raw.eml": RAW }) });
		await seedApiKey(env, "ad_r", { permissions: "read" });
		await seedEmailDrop(env, "e1", "lisa", true);

		const res = await get(env, "/api/inbox/lisa/e1/raw");

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("message/rfc822");
		expect(await res.text()).toBe(RAW);
	});

	test("a drop with no raw message is a 404, not an empty body", async () => {
		const env = makeEnv({ BUCKET: makeBucket({}) });
		await seedApiKey(env, "ad_r", { permissions: "read" });
		await seedEmailDrop(env, "w1", "lisa", false);

		const res = await get(env, "/api/inbox/lisa/w1/raw");

		expect(res.status).toBe(404);
	});

	test("a drop id from another box does not resolve", async () => {
		const env = makeEnv({ BUCKET: makeBucket({ "drops/bob/e2/raw.eml": RAW }) });
		await seedApiKey(env, "ad_r", { permissions: "read" });
		await seedEmailDrop(env, "e2", "bob", true);

		const res = await get(env, "/api/inbox/lisa/e2/raw");

		expect(res.status).toBe(404);
	});
});
