/**
 * Onward delivery: what a webhook event does to the rules engine, and what the
 * rules engine does with it.
 *
 * Two things are being pinned here, and they pull in opposite directions.
 *
 * The engine must keep doing exactly what it did for drops -- `test/rules.test.ts`
 * and `test/forward.test.ts` pass unchanged, which is the phase's own gate, and
 * nothing in this file is allowed to make that less true.
 *
 * And a webhook event must be a first-class subject rather than a drop wearing a
 * hat: its own envelope, its own template variables, and a `passthrough` mode
 * whose entire promise is that the target cannot tell the delivery apart from
 * the provider's own request.
 *
 * Assertions read the ROW back with `env.DB.raw.query` rather than trusting what
 * a handler reported. A delivery log that says `success` while nothing was sent
 * is the failure worth catching, and it can only be caught from the outside.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { handleAPI } from "../src/api/router";
import { fanOutEvent } from "../src/lib/hook-fanout";
import { processWebhookBatch } from "../src/lib/rule-deliver";
import { fireRules } from "../src/lib/rules";
import { serveWebhook } from "../src/lib/webhook-receive";
import { previewRule } from "../tools/lib/rule-preview";
import {
	makeBucket,
	makeCtx,
	makeEnv,
	seedApiKey,
	seedReceiver,
	type TestCtx,
	type TestEnv,
} from "./helpers/env";
import type { WebhookEvent, WebhookQueueMessage, WebhookReceiver } from "../src/types";

const BASE = "https://drop.test";
const WRITER = { Authorization: "Bearer ad_writer_key" };

let env: TestEnv;
let ctx: TestCtx;
let objects: Record<string, string | Uint8Array>;
let sent: WebhookQueueMessage[];
let ruleSeq: number;

interface SeedRule {
	pattern: string;
	type?: "forward" | "webhook";
	target: string;
	scopes?: string;
	headers?: Record<string, string> | null;
	payloadMode?: string;
	enabled?: number;
}

async function seedRule(rule: SeedRule): Promise<string> {
	const id = `rule-${++ruleSeq}`;
	await env.DB.prepare(
		`INSERT INTO drop_rules (id, pattern, type, scopes, target, headers, payload_mode,
			enabled, priority, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
	)
		.bind(
			id,
			rule.pattern,
			rule.type ?? "webhook",
			rule.scopes ?? "all",
			rule.target,
			rule.headers ? JSON.stringify(rule.headers) : null,
			rule.payloadMode ?? "envelope",
			rule.enabled ?? 1,
			ruleSeq,
		)
		.run();
	return id;
}

beforeEach(async () => {
	objects = {};
	sent = [];
	ruleSeq = 0;
	env = makeEnv({
		BUCKET: makeBucket(objects),
		WEBHOOK_QUEUE: {
			send: async (msg: WebhookQueueMessage) => {
				sent.push(msg);
			},
		} as unknown as TestEnv["WEBHOOK_QUEUE"],
	});
	ctx = makeCtx();
	await seedApiKey(env, "ad_writer_key", { name: "writer", permissions: "write" });
});

/** A real delivery through the public endpoint, so events are genuine rows. */
async function deliver(
	slug: string,
	body: string | Uint8Array,
	headers: Record<string, string> = {},
	inbox = "lisa",
): Promise<Response> {
	const url = `${BASE}/h/${inbox}/${slug}`;
	const res = await serveWebhook(
		new Request(url, { method: "POST", headers, body }),
		env,
		new URL(url),
		ctx,
	);
	await ctx.settle();
	return res;
}

function rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
	return env.DB.raw.query(sql).all(...(params as never[])) as T[];
}

function deliveries() {
	return rows<{ drop_id: string; rule_id: string; target: string; status: string; error: string }>(
		"SELECT drop_id, rule_id, target, status, error FROM delivery_log ORDER BY created_at, target",
	);
}

function eventRow(): WebhookEvent {
	return rows<WebhookEvent>("SELECT * FROM webhook_events")[0];
}

describe("the hook channel", () => {
	test("an inbound webhook re-delivers to a second URL", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "gh", preset: "github" });
		const ruleId = await seedRule({ pattern: "lisa", target: "https://second/ingest" });

		const res = await deliver("gh", '{"action":"opened"}', {
			"X-GitHub-Event": "pull_request",
			"X-GitHub-Delivery": "d-1",
		});
		expect(res.status).toBe(200);

		expect(sent).toHaveLength(1);
		expect(sent[0].target).toBe("https://second/ingest");
		expect(sent[0].dropId).toBe(eventRow().id);
		// The row, not the handler's word for it.
		expect(deliveries()).toEqual([
			{
				drop_id: eventRow().id,
				rule_id: ruleId,
				target: "https://second/ingest",
				status: "queued",
				error: null as never,
			},
		]);
	});

	test("the envelope is a hook, not a drop wearing a hat", async () => {
		await seedReceiver(env, {
			inbox: "lisa",
			slug: "track",
			preset: "generic",
			extract: { routingKeyPath: "data.tag", eventTypePath: "event" },
		});
		await seedRule({ pattern: "*", target: "https://h/x" });

		await deliver("track", '{"event":"TRACKING_UPDATED","data":{"tag":"parcel-77"}}');

		const payload = sent[0].payload as {
			event: string;
			hook: Record<string, unknown>;
			rule: { pattern: string };
			captures: Record<string, string>;
		};
		expect(payload.event).toBe("hook.received");
		// A `drop` key here would be a lie about what arrived, and every field in it
		// past `id` and `inbox` would be null.
		expect(payload).not.toHaveProperty("drop");
		expect(payload.hook).toMatchObject({
			id: eventRow().id,
			inbox: "lisa",
			slug: "track",
			event_type: "TRACKING_UPDATED",
			routing_key: "parcel-77",
			method: "POST",
			body: '{"event":"TRACKING_UPDATED","data":{"tag":"parcel-77"}}',
			body_available: true,
			verified: null,
		});
		expect(payload.hook.body_sha256).toBe(eventRow().body_sha256);
		expect(payload.captures).toMatchObject({ channel: "hook", slug: "track" });
	});

	test("{slug}, {event_type} and {routing_key} resolve in a target", async () => {
		await seedReceiver(env, {
			inbox: "shop-eu",
			slug: "orders",
			preset: "generic",
			extract: { routingKeyPath: "id", eventTypePath: "type" },
		});
		await seedRule({
			pattern: "shop-*",
			target: "https://h/{name}/{slug}/{event_type}/{routing_key}",
			headers: { "X-Slug": "{slug}", "X-Type": "{event_type}" },
		});

		await deliver("orders", '{"type":"order.paid","id":"ord-9"}', {}, "shop-eu");

		expect(sent[0].target).toBe("https://h/eu/orders/order.paid/ord-9");
		expect(sent[0].headers).toEqual({ "X-Slug": "orders", "X-Type": "order.paid" });
	});

	test("the hook variables are empty for a drop, not left literal", async () => {
		await seedRule({ pattern: "*", target: "https://h/a{slug}b{event_type}c{routing_key}d" });

		await fireRules(
			env,
			ctx,
			{ id: "drop-1", inbox: "lisa", created_at: 1, topic: null, subject: null },
			"api",
		);
		await ctx.settle();

		expect(sent[0].target).toBe("https://h/abcd");
		// And a drop still publishes the drop envelope, unchanged.
		expect((sent[0].payload as { event: string }).event).toBe("drop.created");
	});

	test('scope "all" covers hook, and a channel list without it does not', async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "s1" });
		await seedRule({ pattern: "*", target: "https://h/all", scopes: "all" });
		await seedRule({ pattern: "*", target: "https://h/hook", scopes: "hook" });
		await seedRule({ pattern: "*", target: "https://h/mail", scopes: "email,web,api" });

		await deliver("s1", "{}");

		expect(sent.map((m) => m.target).sort()).toEqual(["https://h/all", "https://h/hook"]);
	});

	test("a forward rule never fires on the hook channel", async () => {
		// There is no original message to re-send, exactly as for web and api.
		await seedReceiver(env, { inbox: "lisa", slug: "s2" });
		await seedRule({ pattern: "*", type: "forward", target: "someone@x.com", scopes: "all" });

		await deliver("s2", "{}");

		expect(sent).toHaveLength(0);
		expect(deliveries()).toEqual([]);
	});
});

describe("what is not a delivery", () => {
	test("a rejected event fires no rules -- we told the sender no", async () => {
		await seedReceiver(env, {
			inbox: "lisa",
			slug: "signed",
			authMode: "digest",
			authConfig: { secret: "s3cr3t", header: "sign" },
		});
		await seedRule({ pattern: "*", target: "https://h/x" });

		const res = await deliver("signed", '{"a":1}', { sign: "deadbeef" });

		expect(res.status).toBe(401);
		expect(eventRow().status).toBe("rejected");
		// Re-delivering something we refused would be the same lie one layer along,
		// and `passthrough` would put the refused bytes on somebody's wire.
		expect(sent).toHaveLength(0);
		expect(deliveries()).toEqual([]);
	});

	test("a handshake fires no rules -- it is evidence, not work", async () => {
		await seedReceiver(env, {
			inbox: "lisa",
			slug: "slack",
			handshakeMode: "slack",
		});
		await seedRule({ pattern: "*", target: "https://h/x" });

		const res = await deliver("slack", '{"type":"url_verification","challenge":"abc"}');

		expect(res.status).toBe(200);
		expect(eventRow().status).toBe("handshake");
		expect(sent).toHaveLength(0);
		expect(deliveries()).toEqual([]);
	});

	test("fanOutEvent refuses a non-queued row on its own, not just via the caller", async () => {
		// The receive path already returns 401 before it fans out a refusal, so this
		// guard is belt to that braces -- and an untested guard nothing exercises is
		// how a guard silently rots. `fanOutEvent` is exported; a later caller with a
		// row in hand must not be able to turn evidence into work.
		const receiverId = await seedReceiver(env, { inbox: "lisa", slug: "guard" });
		await seedRule({ pattern: "*", target: "https://h/x" });
		const receiver = rows<WebhookReceiver>("SELECT * FROM webhook_receivers")[0];
		receiver.mirror_to_drops = 1;

		for (const status of ["rejected", "handshake", "acked", "leased"] as const) {
			await fanOutEvent(env, ctx, receiver, {
				id: `ev-${status}`,
				receiver_id: receiverId,
				inbox: "lisa",
				slug: "guard",
				status,
				created_at: 1,
			} as WebhookEvent);
			await ctx.settle();
		}

		expect(sent).toHaveLength(0);
		expect(deliveries()).toEqual([]);
		expect(rows("SELECT id FROM drops")).toHaveLength(0);
	});

	test("a deduped retry fires nothing the second time", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "gh2", preset: "github" });
		await seedRule({ pattern: "*", target: "https://h/x" });
		const headers = { "X-GitHub-Event": "push", "X-GitHub-Delivery": "same-id" };

		await deliver("gh2", "{}", headers);
		await deliver("gh2", "{}", headers);

		// One event stored, so one delivery. A retry that fanned out again would
		// deliver the same event twice to a consumer that has no way to tell.
		expect(rows("SELECT id FROM webhook_events")).toHaveLength(1);
		expect(sent).toHaveLength(1);
		expect(deliveries()).toHaveLength(1);
	});

	test("a self-targeting hook rule is refused, not retried for 24 hours", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "loop" });
		await seedRule({ pattern: "*", target: `https://${env.DOMAIN}/h/lisa/loop` });

		await deliver("loop", "{}");

		expect(sent).toHaveLength(0);
		const log = deliveries();
		expect(log).toHaveLength(1);
		expect(log[0].status).toBe("failed");
		expect(log[0].error).toContain("delivery loop");
	});

	test("a rule pointing at somebody else's /h/ is left alone", async () => {
		// The guard is about OUR receiver closing the loop, not about the path shape.
		await seedReceiver(env, { inbox: "lisa", slug: "fine" });
		await seedRule({ pattern: "*", target: "https://elsewhere.example/h/lisa/fine" });

		await deliver("fine", "{}");

		expect(sent).toHaveLength(1);
		expect(deliveries()[0].status).toBe("queued");
	});
});

describe("passthrough", () => {
	let fetched: { url: string; headers: Record<string, string>; body: Uint8Array }[];
	let respond: () => Response;

	beforeEach(() => {
		fetched = [];
		respond = () => new Response("ok", { status: 200 });
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const headers: Record<string, string> = {};
			for (const [k, v] of new Headers(init?.headers).entries()) headers[k] = v;
			const raw = init?.body;
			const body =
				typeof raw === "string"
					? new TextEncoder().encode(raw)
					: new Uint8Array(raw as ArrayBufferView["buffer"] extends never ? never : never) ||
						new Uint8Array();
			fetched.push({
				url: String(input),
				headers,
				body: raw instanceof Uint8Array ? raw : body,
			});
			return respond();
		}) as typeof fetch;
	});

	/**
	 * Run every queued message through the consumer once.
	 *
	 * `attempts` is the PLATFORM's counter, and modelling it correctly is the
	 * point: Cloudflare re-delivers the identical message body on `retry()`, so
	 * anything the consumer needs to know about which attempt this is has to come
	 * from here. A harness that let the consumer bump a field in the body would
	 * make a backoff that never escalates look like one that does.
	 */
	const deliveryCount = new Map<string, number>();

	async function drain(): Promise<{ acked: number; retried: number[] }> {
		const acked: string[] = [];
		const retried: number[] = [];
		const messages = sent.map((body) => {
			const attempts = (deliveryCount.get(body.logId) ?? 0) + 1;
			deliveryCount.set(body.logId, attempts);
			return {
				body,
				attempts,
				ack: () => acked.push(body.logId),
				retry: (opts?: { delaySeconds?: number }) => retried.push(opts?.delaySeconds ?? 0),
			};
		});
		await processWebhookBatch({ messages } as never, env);
		return { acked: acked.length, retried };
	}

	test("the target receives the provider's original bytes and headers", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "stripe", preset: "stripe" });
		await seedRule({ pattern: "*", target: "https://mine/ingest", payloadMode: "passthrough" });

		// Odd key order and an interior newline: a re-serialized copy would not
		// survive either, and a signature over these bytes would stop verifying.
		const body = '{"id":"evt_1",\n "type":"charge.succeeded"}';
		await deliver("stripe", body, {
			"Stripe-Signature": "t=1,v1=abc123",
			Authorization: "Bearer should-not-travel",
			"Content-Type": "application/json",
		});

		expect(sent[0].mode).toBe("passthrough");
		expect(sent[0].payload).toEqual({});

		await drain();

		expect(fetched).toHaveLength(1);
		expect(new TextDecoder().decode(fetched[0].body)).toBe(body);
		// The signature travels verbatim: the target verifies it against these exact
		// bytes, which is the entire point of the mode.
		expect(fetched[0].headers["stripe-signature"]).toBe("t=1,v1=abc123");
		expect(fetched[0].headers["content-type"]).toBe("application/json");
		// A redacted credential is a placeholder, not a header.
		expect(fetched[0].headers.authorization).toBeUndefined();
		// And none of ours: the target must not be able to tell the difference.
		expect(fetched[0].headers["x-drop-id"]).toBeUndefined();
		expect(fetched[0].headers["x-webhook-attempt"]).toBeUndefined();
		expect(fetched[0].headers["user-agent"]).not.toBe("AgentDrop/1.0");
	});

	test("a body that lives in R2 passes through byte-identically", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "bin" });
		await seedRule({ pattern: "*", target: "https://mine/bin", payloadMode: "passthrough" });

		// 0xC3 0x28 is invalid UTF-8, so this body is stored in R2, not inline.
		const raw = new Uint8Array([0x00, 0xff, 0xc3, 0x28, 0x89, 0x50, 0x4e, 0x47, 0xfe, 0xed]);
		await deliver("bin", raw, { "Content-Type": "application/octet-stream" });
		expect(eventRow().body_text).toBeNull();
		expect(eventRow().body_r2_key).toBeTruthy();

		await drain();

		expect(Array.from(fetched[0].body)).toEqual(Array.from(raw));
	});

	test("a rule header overrides a stored one -- that is how you add a target's key", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "ovr" });
		await seedRule({
			pattern: "*",
			target: "https://mine/ovr",
			payloadMode: "passthrough",
			headers: { "X-Api-Key": "for-the-target", "User-Agent": "mine" },
		});

		await deliver("ovr", "{}", { "User-Agent": "Stripe/1.0" });
		await drain();

		expect(fetched[0].headers["x-api-key"]).toBe("for-the-target");
		expect(fetched[0].headers["user-agent"]).toBe("mine");
	});

	test("a destroyed source fails permanently instead of retrying for a day", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "gone" });
		await seedRule({ pattern: "*", target: "https://mine/gone", payloadMode: "passthrough" });

		await deliver("gone", "{}");
		env.DB.raw.query("DELETE FROM webhook_events").run();

		const { acked, retried } = await drain();

		expect(fetched).toHaveLength(0);
		expect(acked).toBe(1);
		expect(retried).toEqual([]);
		const log = deliveries()[0];
		expect(log.status).toBe("failed");
		expect(log.error).toContain("no longer exists");
	});

	test("a drop matched by a passthrough rule still gets the envelope", async () => {
		// There are no original bytes for a drop. Sending nothing would be worse
		// than sending the wrapper.
		await seedRule({ pattern: "*", target: "https://mine/d", payloadMode: "passthrough" });

		await fireRules(env, ctx, { id: "drop-9", inbox: "lisa", created_at: 5 }, "api");
		await ctx.settle();

		expect(sent[0].mode).toBeUndefined();
		expect((sent[0].payload as { event: string }).event).toBe("drop.created");
	});

	test("envelope mode still sends our JSON and our headers", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "env" });
		await seedRule({ pattern: "*", target: "https://mine/env" });

		await deliver("env", '{"hi":1}');
		await drain();

		expect(fetched[0].headers["content-type"]).toBe("application/json");
		expect(fetched[0].headers["user-agent"]).toBe("AgentDrop/1.0");
		expect(fetched[0].headers["x-drop-id"]).toBe(eventRow().id);
		expect(fetched[0].headers["x-webhook-attempt"]).toBe("1");
		expect(JSON.parse(new TextDecoder().decode(fetched[0].body)).event).toBe("hook.received");
	});

	test("a rule header replaces ours instead of being appended to it", async () => {
		// `{"Content-Type": "application/json"}` and `{"content-type": "text/xml"}`
		// are two keys to JavaScript and one header to HTTP: a plain spread keeps
		// both and fetch sends `application/json, text/xml`. Nothing errors, and the
		// target sees a content type nobody wrote.
		await seedReceiver(env, { inbox: "lisa", slug: "case" });
		await seedRule({
			pattern: "*",
			target: "https://mine/case",
			headers: { "content-type": "application/cloudevents+json", "x-drop-id": "mine" },
		});

		await deliver("case", "{}");
		await drain();

		expect(fetched[0].headers["content-type"]).toBe("application/cloudevents+json");
		expect(fetched[0].headers["x-drop-id"]).toBe("mine");
	});

	test("a failing target retries with an ESCALATING backoff, and the log follows it", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "flaky" });
		await seedRule({ pattern: "*", target: "https://mine/flaky" });

		await deliver("flaky", "{}");
		respond = () => new Response("nope", { status: 503 });

		const first = await drain();
		expect(first.acked).toBe(0);
		expect(first.retried).toEqual([2]);

		let log = deliveries()[0];
		expect(log.status).toBe("retrying");
		expect(log.error).toContain("HTTP 503");
		expect(
			rows<{ attempts: number; status_code: number }>(
				"SELECT attempts, status_code FROM delivery_log",
			)[0],
		).toEqual({ attempts: 1, status_code: 503 });

		// The queue re-delivers the IDENTICAL body -- there is no way to mutate it --
		// so anything that has to grow between attempts must come from the platform's
		// own counter. Reading it out of the body instead gives 2 seconds forever:
		// about 43,000 requests at a dead target over the 24-hour window instead of
		// the ~80 the documented ladder implies, with the log stuck reporting one.
		respond = () => new Response("nope", { status: 500 });
		for (const expected of [4, 8, 16]) {
			expect((await drain()).retried).toEqual([expected]);
		}
		expect(rows<{ attempts: number }>("SELECT attempts FROM delivery_log")[0].attempts).toBe(4);

		// And a success closes it out, recording how many it really took.
		respond = () => new Response("ok", { status: 200 });
		expect((await drain()).acked).toBe(1);
		log = deliveries()[0];
		expect(log.status).toBe("success");
		expect(rows<{ attempts: number }>("SELECT attempts FROM delivery_log")[0].attempts).toBe(5);
	});

	test("the attempt header counts real deliveries, not the one in the body", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "hdr" });
		await seedRule({ pattern: "*", target: "https://mine/hdr" });

		await deliver("hdr", "{}");
		respond = () => new Response("no", { status: 500 });
		await drain();
		respond = () => new Response("ok", { status: 200 });
		await drain();

		expect(fetched.map((f) => f.headers["x-webhook-attempt"])).toEqual(["1", "2"]);
	});
});

describe("mirror_to_drops", () => {
	test("is off by default -- an event does not become a drop", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "plain" });

		await deliver("plain", '{"a":1}');

		expect(rows("SELECT id FROM drops")).toHaveLength(0);
	});

	test("when on, an accepted event is written into drops as well", async () => {
		const id = await seedReceiver(env, { inbox: "lisa", slug: "mir", preset: "generic" });
		env.DB.raw.query("UPDATE webhook_receivers SET mirror_to_drops = 1 WHERE id = ?").run(id);

		await deliver("mir", '{"type":"a.b"}', { "CF-Connecting-IP": "203.0.113.9" });

		const drop = rows<{
			inbox: string;
			channel: string;
			subject: string;
			body_text: string;
			metadata: string;
		}>("SELECT * FROM drops")[0];
		expect(drop.inbox).toBe("lisa");
		expect(drop.channel).toBe("hook");
		expect(drop.body_text).toBe('{"type":"a.b"}');
		expect(JSON.parse(drop.metadata)).toMatchObject({
			auth_method: "webhook",
			hook_event_id: eventRow().id,
			slug: "mir",
			remote_ip: "203.0.113.9",
		});
		// The queue is untouched: mirroring is a copy, not a move.
		expect(eventRow().status).toBe("queued");
	});

	test("the mirror does not re-fire rules", async () => {
		const id = await seedReceiver(env, { inbox: "lisa", slug: "mir2" });
		env.DB.raw.query("UPDATE webhook_receivers SET mirror_to_drops = 1 WHERE id = ?").run(id);
		await seedRule({ pattern: "*", target: "https://h/once", scopes: "all" });

		await deliver("mir2", "{}");

		// Once for the hook channel. A second delivery for the mirrored copy would
		// hand the same event to a `scopes: all` consumer twice.
		expect(sent).toHaveLength(1);
		expect(deliveries()).toHaveLength(1);
	});

	test("a rejected event is never mirrored", async () => {
		const id = await seedReceiver(env, {
			inbox: "lisa",
			slug: "mir3",
			authMode: "bearer",
			authConfig: { secret: "right" },
		});
		env.DB.raw.query("UPDATE webhook_receivers SET mirror_to_drops = 1 WHERE id = ?").run(id);

		await deliver("mir3", "{}", { Authorization: "Bearer wrong" });

		expect(eventRow().status).toBe("rejected");
		expect(rows("SELECT id FROM drops")).toHaveLength(0);
	});
});

describe("rule-test's dry run agrees with the engine", () => {
	// `previewRule` predicts what `fireRules` will do, client-side. A dry run that
	// disagrees with the engine is worse than no dry run: you check it precisely
	// when you are unsure, and it answers with confidence either way.
	const vars = { inbox: "lisa", channel: "hook", slug: "s", event_type: "e" };

	test("a forward is reported as NOT firing on any channel but email", async () => {
		const rule = {
			pattern: "*",
			type: "forward",
			scopes: "all",
			target: "a@x.com",
			enabled: 1,
		};

		for (const channel of ["web", "api", "hook"]) {
			const verdict = previewRule(rule, "lisa", channel, { ...vars, channel });
			expect(verdict?.fires).toBe(false);
			expect(verdict && !verdict.fires && verdict.reason).toContain("email");
		}
		// And on email it does fire, which is the half that was already right.
		expect(previewRule(rule, "lisa", "email", vars)?.fires).toBe(true);
	});

	test("the engine agrees: a forward on hook delivers nothing", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "dry" });
		await seedRule({ pattern: "*", type: "forward", target: "a@x.com", scopes: "all" });

		await deliver("dry", "{}");

		expect(deliveries()).toEqual([]);
	});

	test("scope, disabled and no-match are each their own answer", () => {
		const base = { pattern: "*", type: "webhook", target: "https://h/x", enabled: 1 };
		expect(previewRule({ ...base, scopes: "email" }, "lisa", "hook", vars)).toMatchObject({
			fires: false,
		});
		expect(previewRule({ ...base, scopes: "all", enabled: 0 }, "lisa", "hook", vars)).toMatchObject(
			{ fires: false, reason: "DISABLED" },
		);
		// A pattern that does not match is not worth a line of output at all.
		expect(
			previewRule({ ...base, pattern: "bob", scopes: "all" }, "lisa", "hook", vars),
		).toBeNull();
	});

	test("a firing verdict substitutes the hook variables", () => {
		const verdict = previewRule(
			{ pattern: "*", type: "webhook", scopes: "all", target: "https://h/{slug}/{event_type}" },
			"lisa",
			"hook",
			{ ...vars, enabled: undefined } as never,
		);
		// `enabled` undefined is a disabled rule, so this one must NOT fire -- the
		// list API always sends the column.
		expect(verdict?.fires).toBe(false);

		const live = previewRule(
			{
				pattern: "*",
				type: "webhook",
				scopes: "all",
				target: "https://h/{slug}/{event_type}",
				enabled: 1,
			},
			"lisa",
			"hook",
			vars,
		);
		expect(live).toMatchObject({ fires: true, target: "https://h/s/e" });
	});
});

describe("hook-replay", () => {
	function replay(inbox: string, id: string, body: unknown = {}) {
		return handleAPI(
			new Request(`${BASE}/api/hooks/queue/${inbox}/${id}/replay`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...WRITER },
				body: JSON.stringify(body),
			}),
			env,
			new URL(`${BASE}/api/hooks/queue/${inbox}/${id}/replay`),
			makeCtx(),
		);
	}

	test("--to queues one delivery through the retry machinery", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "r1" });
		await deliver("r1", '{"n":1}');
		const id = eventRow().id;

		const res = await replay("lisa", id, { to: "https://elsewhere/x" });
		expect(res.status).toBe(200);

		expect(sent).toHaveLength(1);
		expect(sent[0].target).toBe("https://elsewhere/x");
		expect(sent[0].eventId).toBe(id);
		// Logged like any other delivery, so `drop deliveries` shows the replay.
		const log = deliveries()[0];
		expect(log).toMatchObject({ drop_id: id, rule_id: "replay", status: "queued" });
	});

	test("--to --mode passthrough re-sends the original bytes", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "r2" });
		await deliver("r2", '{"n":2}');
		const id = eventRow().id;

		await replay("lisa", id, { to: "https://elsewhere/y", mode: "passthrough" });

		expect(sent[0].mode).toBe("passthrough");
		expect(sent[0].payload).toEqual({});
		expect(sent[0].eventInbox).toBe("lisa");
	});

	test("with no target it re-fires the rules that match now", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "r3" });
		await deliver("r3", '{"n":3}');
		const id = eventRow().id;
		expect(sent).toHaveLength(0);

		// The rule is added AFTER the event landed -- which is the whole reason this
		// form exists.
		await seedRule({ pattern: "lisa", target: "https://added/later" });
		const res = await replay("lisa", id);
		const body = (await res.json()) as { mode: string; deliveries: { target: string }[] };

		expect(sent.map((m) => m.target)).toEqual(["https://added/later"]);
		// The response reports what it queued, which means it waited for the
		// deferred work rather than racing it.
		expect(body.mode).toBe("rules");
		expect(body.deliveries.map((d) => d.target)).toEqual(["https://added/later"]);
	});

	test("a handshake and a rejected event are both refused", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "hs", handshakeMode: "echo" });
		await deliver("hs", "challenge-abc");
		const handshakeId = eventRow().id;
		expect(eventRow().status).toBe("handshake");

		const res = await replay("lisa", handshakeId, { to: "https://x/y" });
		expect(res.status).toBe(409);
		expect(sent).toHaveLength(0);

		env.DB.raw.query("UPDATE webhook_events SET status = 'rejected' WHERE id = ?").run(handshakeId);
		expect((await replay("lisa", handshakeId, { to: "https://x/y" })).status).toBe(409);
		expect(sent).toHaveLength(0);
	});

	test("an event in another box is not reachable by id", async () => {
		await seedReceiver(env, { inbox: "bob", slug: "r4" });
		await deliver("r4", "{}", {}, "bob");
		const id = eventRow().id;

		const res = await replay("lisa", id, { to: "https://x/y" });
		expect(res.status).toBe(404);
		expect(sent).toHaveLength(0);
	});

	test("a non-http target is refused before anything is queued", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "r5" });
		await deliver("r5", "{}");

		const res = await replay("lisa", eventRow().id, { to: "file:///etc/passwd" });
		expect(res.status).toBe(400);
		expect(sent).toHaveLength(0);
		expect(deliveries()).toEqual([]);
	});

	test("replay is a write, so a read-only key cannot do it", async () => {
		await seedApiKey(env, "ad_read_key", { name: "reader", permissions: "read" });
		await seedReceiver(env, { inbox: "lisa", slug: "r6" });
		await deliver("r6", "{}");
		const id = eventRow().id;
		const path = `/api/hooks/queue/lisa/${id}/replay`;

		const res = await handleAPI(
			new Request(`${BASE}${path}`, {
				method: "POST",
				headers: { Authorization: "Bearer ad_read_key" },
			}),
			env,
			new URL(`${BASE}${path}`),
			makeCtx(),
		);

		expect(res.status).toBe(403);
		expect(sent).toHaveLength(0);
	});
});
