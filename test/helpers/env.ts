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

export interface TestCtx extends ExecutionContext {
	/** Everything handed to waitUntil, in call order. */
	waits: Promise<unknown>[];
	/** Await every deferred task, including ones queued while draining. */
	settle(): Promise<void>;
}

/**
 * fireRules() does its real work inside ctx.waitUntil, so a no-op waitUntil
 * makes every assertion about forwards and webhooks vacuously pass. This one
 * keeps the promises and settle() drains them.
 */
export function makeCtx(): TestCtx {
	const waits: Promise<unknown>[] = [];
	return {
		waits,
		waitUntil: (p: Promise<unknown>) => {
			waits.push(p);
		},
		passThroughOnException: () => {},
		async settle() {
			// A deferred task may itself defer; keep draining until nothing new lands.
			for (let seen = 0; seen < waits.length; ) {
				const pending = waits.slice(seen);
				seen = waits.length;
				await Promise.allSettled(pending);
			}
		},
	} as unknown as TestCtx;
}

/**
 * An R2Bucket over a plain map of key -> body, enough for read paths.
 *
 * Bodies are kept EXACTLY as they were put. A webhook body may be arbitrary
 * bytes -- that is the whole promise of the receiver -- so coercing everything
 * to a string here would make byte fidelity untestable, which is precisely the
 * thing the tests exist to prove.
 */
export function makeBucket(objects: Record<string, string | Uint8Array> = {}): R2Bucket & {
	heads: string[];
	deletes: string[];
} {
	const heads: string[] = [];
	const deletes: string[] = [];
	const sizeOf = (body: string | Uint8Array) =>
		typeof body === "string" ? body.length : body.byteLength;
	return {
		heads,
		deletes,
		list: async ({ prefix = "" }: { prefix?: string } = {}) => ({
			objects: Object.entries(objects)
				.filter(([key]) => key.startsWith(prefix))
				.map(([key, body]) => ({ key, size: sizeOf(body) })),
			truncated: false as const,
			delimitedPrefixes: [],
		}),
		delete: async (keys: string | string[]) => {
			for (const key of Array.isArray(keys) ? keys : [keys]) {
				deletes.push(key);
				delete objects[key];
			}
		},
		put: async (key: string, body: string | Uint8Array | ArrayBuffer) => {
			objects[key] = body instanceof ArrayBuffer ? new Uint8Array(body) : body;
			return { key };
		},
		get: async (key: string) => {
			if (!(key in objects)) return null;
			const body = objects[key];
			return {
				key,
				body: new Response(body).body,
				httpEtag: `"etag-${key}"`,
				writeHttpMetadata: (_headers: Headers) => {},
				text: async () => (typeof body === "string" ? body : new TextDecoder().decode(body)),
				arrayBuffer: async () =>
					typeof body === "string" ? new TextEncoder().encode(body).buffer : body.buffer,
			};
		},
		head: async (key: string) => {
			heads.push(key);
			if (!(key in objects)) return null;
			return { key, size: sizeOf(objects[key]), httpEtag: `"etag-${key}"` };
		},
	} as unknown as R2Bucket & { heads: string[]; deletes: string[] };
}

/**
 * Hold every statement whose SQL starts with `sqlPrefix` until `release()` is
 * called; then it runs for real.
 *
 * The FakeD1 executes SQLite synchronously inside an `async` method, so its
 * writes land before the returned promise ever yields. Real D1 is a network
 * round trip. Without this gate, "the response came back before the write
 * landed" is untestable -- the fake would make an inline `await` look deferred.
 */
export function gateStatement(env: TestEnv, sqlPrefix: string): { release: () => void } {
	let open!: () => void;
	const gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	const realPrepare = env.DB.prepare.bind(env.DB);
	env.DB.prepare = ((sql: string) => {
		const stmt = realPrepare(sql);
		if (!sql.startsWith(sqlPrefix)) return stmt;
		const wrap = (bound: typeof stmt) =>
			({
				bind: (...args: unknown[]) => wrap(bound.bind(...args)),
				run: async () => {
					await gate;
					return bound.run();
				},
				first: bound.first.bind(bound),
				all: bound.all.bind(bound),
			}) as unknown as typeof stmt;
		return wrap(stmt);
	}) as typeof env.DB.prepare;
	return { release: open };
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
		createdAt?: number;
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
			opts.createdAt ?? Date.now(),
		)
		.run();
}

export interface SeedReceiver {
	id?: string;
	inbox: string;
	slug: string;
	authMode?: string;
	authConfig?: Record<string, unknown> | null;
	handshakeMode?: string;
	preset?: string | null;
	extract?: Record<string, unknown> | null;
	methods?: string;
	maxBodyBytes?: number;
	retentionDays?: number;
	responseStatus?: number;
	responseBody?: string | null;
	responseContentType?: string | null;
	enabled?: number;
	expiresAt?: number | null;
	previousSlug?: string | null;
	previousSlugExpiresAt?: number | null;
}

/** A receiver row, written straight in -- the CRUD API has its own tests. */
export async function seedReceiver(env: TestEnv, opts: SeedReceiver): Promise<string> {
	const id = opts.id ?? crypto.randomUUID();
	await env.DB.prepare(
		`INSERT INTO webhook_receivers (
			id, inbox, slug, auth_mode, auth_config, handshake_mode, preset, extract_config,
			allowed_methods, max_body_bytes, retention_days, response_status, response_body,
			response_content_type, enabled, expires_at, previous_slug, previous_slug_expires_at,
			created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			id,
			opts.inbox,
			opts.slug,
			opts.authMode ?? "none",
			opts.authConfig ? JSON.stringify(opts.authConfig) : null,
			opts.handshakeMode ?? "none",
			opts.preset ?? null,
			opts.extract ? JSON.stringify(opts.extract) : null,
			opts.methods ?? "POST",
			opts.maxBodyBytes ?? 1_048_576,
			opts.retentionDays ?? 120,
			opts.responseStatus ?? 200,
			opts.responseBody ?? null,
			opts.responseContentType ?? null,
			opts.enabled ?? 1,
			opts.expiresAt ?? null,
			opts.previousSlug ?? null,
			opts.previousSlugExpiresAt ?? null,
			Date.now(),
		)
		.run();
	return id;
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
