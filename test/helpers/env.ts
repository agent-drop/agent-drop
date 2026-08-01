import type { Env } from "../../src/types";
import { type FakeD1, makeD1 } from "./d1";

export const TEST_ADMIN_KEY = "admin-secret-do-not-guess";
export const TEST_DOMAIN = "drop.test";

export async function sha256Hex(value: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** A rate limiter that lets everything through, and records what it was asked. */
export function allowAll(): RateLimit & { keys: string[] } {
	const keys: string[] = [];
	return {
		keys,
		limit: async ({ key }: { key?: string }) => {
			keys.push(key ?? "");
			return { success: true };
		},
	} as RateLimit & { keys: string[] };
}

/** A rate limiter that is already exhausted. */
export function denyAll(): RateLimit & { keys: string[] } {
	const keys: string[] = [];
	return {
		keys,
		limit: async ({ key }: { key?: string }) => {
			keys.push(key ?? "");
			return { success: false };
		},
	} as RateLimit & { keys: string[] };
}

export interface TestEnv extends Env {
	DB: FakeD1 & Env["DB"];
}

export function makeEnv(overrides: Partial<Env> = {}): TestEnv {
	return {
		DB: makeD1(),
		BUCKET: {} as R2Bucket,
		ASSETS: {} as Fetcher,
		DOMAIN: TEST_DOMAIN,
		BRAND: "Agent Drop",
		R2_ACCOUNT_ID: "test-account",
		SES_REGION: "eu-central-1",
		AWS_ACCESS_KEY_ID: "aws-test",
		AWS_SECRET_ACCESS_KEY: "aws-test-secret",
		ADMIN_API_KEY: TEST_ADMIN_KEY,
		GOOGLE_CLIENT_ID: "google-test",
		GOOGLE_CLIENT_ID_PUBLIC: "google-test-public",
		R2_ACCESS_KEY_ID: "r2-test",
		R2_SECRET_ACCESS_KEY: "r2-test-secret",
		WEBHOOK_QUEUE: { send: async () => {} } as unknown as Env["WEBHOOK_QUEUE"],
		EMAIL: {} as Env["EMAIL"],
		AUTH_RATE_LIMIT: allowAll(),
		UPLOAD_RATE_LIMIT: allowAll(),
		...overrides,
	} as unknown as TestEnv;
}

export function makeCtx(): ExecutionContext {
	return {
		waitUntil: () => {},
		passThroughOnException: () => {},
	} as unknown as ExecutionContext;
}

export async function seedApiKey(
	env: TestEnv,
	key: string,
	opts: { name?: string; inboxScope?: string | null; permissions?: string } = {},
): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO api_keys (id, key_hash, name, inbox_scope, permissions, created_at) VALUES (?, ?, ?, ?, ?, ?)",
	)
		.bind(
			crypto.randomUUID(),
			await sha256Hex(key),
			opts.name ?? "test-key",
			opts.inboxScope ?? null,
			opts.permissions ?? "write",
			Date.now(),
		)
		.run();
}

export async function seedDropToken(
	env: TestEnv,
	token: string,
	inbox: string,
	ttlMs = 3_600_000,
): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO drop_tokens (id, inbox, token_hash, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
	)
		.bind(crypto.randomUUID(), inbox, await sha256Hex(token), Date.now() + ttlMs, null, Date.now())
		.run();
}

export async function seedPendingDrop(
	env: TestEnv,
	opts: {
		id: string;
		inbox: string;
		fileName?: string;
		objectKey?: string | null;
		status?: string;
	},
): Promise<void> {
	const fileName = opts.fileName ?? "report.pdf";
	const r2Prefix = `drops/${opts.inbox}/${opts.id}`;
	await env.DB.prepare(
		`INSERT INTO drops (id, inbox, channel, subject, has_attachments, attachment_count,
			r2_prefix, object_key, metadata, status, created_at)
		VALUES (?, ?, 'web', ?, 1, 1, ?, ?, '{}', ?, ?)`,
	)
		.bind(
			opts.id,
			opts.inbox,
			fileName,
			r2Prefix,
			opts.objectKey === undefined ? `${r2Prefix}/uploads/${fileName}` : opts.objectKey,
			opts.status ?? "pending",
			Date.now(),
		)
		.run();
}

export function dropStatus(env: TestEnv, id: string): string | undefined {
	const row = env.DB.raw.query("SELECT status FROM drops WHERE id = ?").get(id) as
		| { status: string }
		| undefined;
	return row?.status;
}

export function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}) {
	return new Request(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7", ...headers },
		body: JSON.stringify(body),
	});
}
