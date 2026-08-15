/**
 * Driving `verifyWebhook` without a database or a request pipeline in the way.
 *
 * A receiver is just a row, so the tests build one by hand rather than seeding
 * D1: the verifier reads exactly three of its columns and nothing else, and a
 * test that has to insert twenty-six of them to check one signature is a test
 * nobody will add the twelfth case to.
 */

import { verifyWebhook, type VerifyResult } from "../../src/lib/webhook-verify";
import type { WebhookReceiver } from "../../src/types";

export function fakeReceiver(authMode: string, authConfig?: Record<string, unknown>) {
	return {
		id: "rcv_test",
		inbox: "lisa",
		slug: "hook",
		label: null,
		auth_mode: authMode,
		auth_config: authConfig ? JSON.stringify(authConfig) : null,
		handshake_mode: "none",
		handshake_config: null,
		preset: null,
		extract_config: null,
		response_status: 200,
		response_body: null,
		response_content_type: null,
		allowed_methods: "POST",
		max_body_bytes: 1_048_576,
		retention_days: 120,
		daily_cap: null,
		mirror_to_drops: 0,
		enabled: 1,
		previous_slug: null,
		previous_slug_expires_at: null,
		expires_at: null,
		created_at: 0,
		last_event_at: null,
		event_count: 0,
	} satisfies WebhookReceiver;
}

export interface VerifyOptions {
	mode: string;
	config?: Record<string, unknown>;
	/** Passed to the verifier as raw bytes, never re-encoded on the way in. */
	body: string | Uint8Array;
	headers?: Record<string, string>;
	url?: string;
	method?: string;
	now: number;
}

export function verify(opts: VerifyOptions): Promise<VerifyResult> {
	const bytes = typeof opts.body === "string" ? new TextEncoder().encode(opts.body) : opts.body;
	const url = new URL(opts.url ?? "https://drop.test/h/lisa/hook");
	return verifyWebhook({
		receiver: fakeReceiver(opts.mode, opts.config),
		headers: new Headers(opts.headers ?? {}),
		url,
		method: opts.method ?? "POST",
		bytes,
		now: opts.now,
	});
}

/**
 * Flip exactly ONE BIT of ONE BYTE, near the end but never the last character.
 *
 * The point of the tamper tests is that a signature covers the bytes and not a
 * parse of them, so the mutation has to be at the byte level -- rewriting the
 * JSON would also prove something, but something weaker and easier to pass by
 * accident. `^ 0x01` on printable ASCII stays printable ASCII, so the tampered
 * body is still a plausible request rather than obvious garbage.
 */
export function flipOneByte(body: string): Uint8Array {
	const bytes = new TextEncoder().encode(body);
	bytes[bytes.length - 2] ^= 0x01;
	return bytes;
}
