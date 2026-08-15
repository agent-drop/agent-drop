import { beforeEach, describe, expect, test } from "bun:test";
import { serveWebhook } from "../src/lib/webhook-receive";
import {
	gateStatement,
	makeBucket,
	makeCtx,
	makeEnv,
	seedReceiver,
	type TestCtx,
	type TestEnv,
} from "./helpers/env";

// The receiver is the one channel agent-drop does not control the producer of,
// so faithful preservation of what arrived IS the product. Everything below is
// ultimately one question: can a consumer holding the provider's secret verify a
// signature against what we stored? That is only true if the bytes never
// changed, the headers were not curated, and nothing was re-serialized on the
// way in.

let env: TestEnv;
let ctx: TestCtx;
let objects: Record<string, string | Uint8Array>;

beforeEach(() => {
	objects = {};
	env = makeEnv({ BUCKET: makeBucket(objects) });
	ctx = makeCtx();
});

function post(
	path: string,
	body: BodyInit | null,
	init: { headers?: Record<string, string>; method?: string } = {},
) {
	return new Request(`https://drop.test${path}`, {
		method: init.method ?? "POST",
		headers: init.headers,
		body,
	});
}

function serve(request: Request) {
	return serveWebhook(request, env, new URL(request.url), ctx);
}

function rows(sql: string, ...params: unknown[]) {
	return env.DB.raw.query(sql).all(...(params as never[])) as Record<string, any>[];
}

function onlyEvent() {
	const found = rows("SELECT * FROM webhook_events");
	expect(found.length).toBe(1);
	return found[0];
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

describe("byte fidelity", () => {
	// The reason this matters: a provider signs the exact bytes it sent. Key
	// order, whitespace and unicode escaping all shift if you parse and
	// re-serialize, and once the re-serialized form is what you stored, the
	// evidence is gone permanently.
	test("stores the body verbatim, quirks and all", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "stripe" });
		// Deliberately ugly: key order that JSON.stringify would not reproduce,
		// interior whitespace, an escaped unicode sequence and a literal one.
		const raw = '{ "z":1,\n  "a" : "caf\\u00e9 é",  "n":1.50 }';

		const res = await serve(
			post("/h/lisa/stripe", raw, { headers: { "Content-Type": "application/json" } }),
		);
		expect(res.status).toBe(200);

		const event = onlyEvent();
		expect(event.body_text).toBe(raw);
		expect(event.body_sha256).toBe(await sha256Of(new TextEncoder().encode(raw)));
		expect(event.body_bytes).toBe(new TextEncoder().encode(raw).byteLength);
		expect(event.body_r2_key).toBeNull();
	});

	test("a non-UTF-8 body goes to R2 unmodified and is never decoded", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "binary" });
		// 0xC3 0x28 is an invalid UTF-8 sequence; a lossy decode would turn it into
		// U+FFFD and the original byte would be gone.
		const bytes = new Uint8Array([0x00, 0xff, 0xc3, 0x28, 0x7b, 0x22, 0x61, 0x22, 0x7d, 0xfe]);

		const res = await serve(post("/h/lisa/binary", bytes));
		expect(res.status).toBe(200);

		const event = onlyEvent();
		expect(event.body_text).toBeNull();
		expect(event.body_r2_key).toBe(`hooks/lisa/binary/${event.id}`);
		expect(event.body_sha256).toBe(await sha256Of(bytes));

		const stored = objects[event.body_r2_key] as Uint8Array;
		expect(Array.from(stored)).toEqual(Array.from(bytes));
	});

	test("a body over the inline limit goes to R2 byte-identical", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "big" });
		const raw = `{"pad":"${"x".repeat(70_000)}"}`;

		const res = await serve(
			post("/h/lisa/big", raw, { headers: { "Content-Type": "application/json" } }),
		);
		expect(res.status).toBe(200);

		const event = onlyEvent();
		expect(event.body_text).toBeNull();
		expect(event.body_bytes).toBe(raw.length);
		const stored = objects[event.body_r2_key] as Uint8Array;
		expect(new TextDecoder().decode(stored)).toBe(raw);
	});

	test("a body that is valid UTF-8 but not JSON still stores and answers 200", async () => {
		// A dashboard "test" button firing an unspecified ping is the normal case
		// here, not an error. The receiver preserves; it does not understand.
		await seedReceiver(env, { inbox: "lisa", slug: "junk" });

		const res = await serve(
			post("/h/lisa/junk", "not json at all {", {
				headers: { "Content-Type": "application/json" },
			}),
		);

		expect(res.status).toBe(200);
		expect(onlyEvent().body_text).toBe("not json at all {");
	});

	test("an empty body is a successful receive", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "ping" });

		const res = await serve(post("/h/lisa/ping", null));

		expect(res.status).toBe(200);
		const event = onlyEvent();
		expect(event.body_text).toBe("");
		expect(event.body_bytes).toBe(0);
	});
});

describe("header storage", () => {
	test("keeps the complete map, and signature headers verbatim", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "gh" });

		await serve(
			post("/h/lisa/gh", "{}", {
				headers: {
					"Content-Type": "application/json",
					"X-Hub-Signature-256": "sha256=deadbeef",
					sign: "17track-style-digest",
					"Stripe-Signature": "t=1,v1=abc",
					"X-Custom-Thing": "kept",
				},
			}),
		);

		const stored = JSON.parse(onlyEvent().headers);
		// An allowlist cannot work -- the signature header is a different name for
		// every provider -- and an HMAC proves one specific body came from the
		// signer, so it is worthless against any other request. Redacting it would
		// only make consumer-side verification impossible.
		expect(stored["x-hub-signature-256"]).toBe("sha256=deadbeef");
		expect(stored.sign).toBe("17track-style-digest");
		expect(stored["stripe-signature"]).toBe("t=1,v1=abc");
		expect(stored["x-custom-thing"]).toBe("kept");
	});

	test("redacts headers that are credentials in their own right", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "creds" });

		await serve(
			post("/h/lisa/creds", "{}", {
				headers: {
					Authorization: "Bearer super-secret",
					Cookie: "session=secret",
					"X-Keep-Me": "visible",
				},
			}),
		);

		const stored = JSON.parse(onlyEvent().headers);
		expect(stored.authorization).toBe("<redacted>");
		expect(stored.cookie).toBe("<redacted>");
		expect(stored["x-keep-me"]).toBe("visible");
	});

	test("redacts whatever this receiver's own auth_config names as a secret", async () => {
		await seedReceiver(env, {
			inbox: "lisa",
			slug: "hdr",
			authConfig: { header: "X-Shared-Token" },
		});

		await serve(post("/h/lisa/hdr", "{}", { headers: { "X-Shared-Token": "t0ps3cret" } }));

		expect(JSON.parse(onlyEvent().headers)["x-shared-token"]).toBe("<redacted>");
	});

	test("records the query string and the subpath", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "sub" });

		await serve(post("/h/lisa/sub/orders/created?tag=abc&x=1", "{}"));

		const event = onlyEvent();
		expect(event.subpath).toBe("orders/created");
		expect(JSON.parse(event.query)).toEqual({ tag: "abc", x: "1" });
	});
});

describe("the status table", () => {
	// Every one of these is a decision, because the provider on the other end
	// reacts to the number: a 2xx makes it stop, a 4xx makes it stop and show an
	// error, a 5xx makes it retry.
	test("an unregistered slug is 404, which leaks nothing", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "real" });

		const res = await serve(post("/h/lisa/not-real", "{}"));

		expect(res.status).toBe(404);
		// 403 would mean "this exists and you may not have it", confirming the slug
		// is real -- a yes/no oracle against a URL that IS the credential.
		expect((await res.json()) as Record<string, unknown>).toEqual({ error: "no such receiver" });
		expect(rows("SELECT * FROM webhook_events").length).toBe(0);
	});

	test("an unknown box is 404 too", async () => {
		const res = await serve(post("/h/nobody/anything", "{}"));
		expect(res.status).toBe(404);
	});

	test("a disabled receiver is 403 -- it IS registered, the operator turned it off", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "off", enabled: 0 });

		const res = await serve(post("/h/lisa/off", "{}"));

		expect(res.status).toBe(403);
		expect((await res.json()) as Record<string, unknown>).toEqual({ error: "receiver disabled" });
	});

	test("an expired receiver is 410 -- gone permanently, stop sending", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "old", expiresAt: Date.now() - 1000 });

		const res = await serve(post("/h/lisa/old", "{}"));

		expect(res.status).toBe(410);
		expect((await res.json()) as Record<string, unknown>).toEqual({ error: "receiver expired" });
	});

	test("a method outside allowed_methods is 405 and says what is allowed", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "postonly", methods: "POST" });

		const res = await serve(post("/h/lisa/postonly", null, { method: "GET" }));

		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("POST");
	});

	test("a declared Content-Length over the cap is 413 before the body is read", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "small", maxBodyBytes: 10 });

		const res = await serve(
			post("/h/lisa/small", "x".repeat(100), { headers: { "Content-Length": "100" } }),
		);

		expect(res.status).toBe(413);
		expect(rows("SELECT * FROM webhook_events").length).toBe(0);
	});

	test("a body over the cap is 413 even when no length was declared", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "chunked", maxBodyBytes: 10 });
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("x".repeat(50)));
				controller.close();
			},
		});

		const res = await serveWebhook(
			new Request("https://drop.test/h/lisa/chunked", {
				method: "POST",
				body: stream,
				// Required for a streamed request body.
				duplex: "half",
			}),
			env,
			new URL("https://drop.test/h/lisa/chunked"),
			ctx,
		);

		expect(res.status).toBe(413);
	});

	test("our own failure is 503 -- the only case a provider should retry", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "boom" });
		env.DB.prepare = (() => {
			throw new Error("D1 is down");
		}) as typeof env.DB.prepare;

		const res = await serve(post("/h/lisa/boom", "{}"));

		expect(res.status).toBe(503);
	});

	test("a receiver may override the response the provider sees", async () => {
		await seedReceiver(env, {
			inbox: "lisa",
			slug: "custom",
			responseStatus: 202,
			responseBody: "ACCEPTED",
			responseContentType: "text/plain",
		});

		const res = await serve(post("/h/lisa/custom", "{}"));

		expect(res.status).toBe(202);
		expect(await res.text()).toBe("ACCEPTED");
	});
});

describe("slug rotation", () => {
	test("the old slug keeps answering inside its grace window", async () => {
		await seedReceiver(env, {
			inbox: "lisa",
			slug: "new-slug",
			previousSlug: "old-slug",
			previousSlugExpiresAt: Date.now() + 60_000,
		});

		const res = await serve(post("/h/lisa/old-slug", "{}"));

		expect(res.status).toBe(200);
		// The event files under the CURRENT slug: rotation must not fork the history.
		expect(onlyEvent().slug).toBe("new-slug");
	});

	test("past the grace window the old slug is gone", async () => {
		await seedReceiver(env, {
			inbox: "lisa",
			slug: "new-slug",
			previousSlug: "old-slug",
			previousSlugExpiresAt: Date.now() - 1,
		});

		expect((await serve(post("/h/lisa/old-slug", "{}"))).status).toBe(404);
	});
});

describe("extraction and dedupe", () => {
	test("the github preset reads the event type and delivery id from headers", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "gh", preset: "github" });

		await serve(
			post("/h/lisa/gh", "{}", {
				headers: { "X-GitHub-Event": "push", "X-GitHub-Delivery": "delivery-1" },
			}),
		);

		const event = onlyEvent();
		expect(event.event_type).toBe("push");
		expect(event.dedupe_key).toBe("delivery-1");
	});

	test("a retry carrying the same message id stores once and still answers 200", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "gh", preset: "github" });
		const headers = { "X-GitHub-Event": "push", "X-GitHub-Delivery": "same-id" };

		const first = await serve(post("/h/lisa/gh", '{"n":1}', { headers }));
		const second = await serve(post("/h/lisa/gh", '{"n":1}', { headers }));

		expect(first.status).toBe(200);
		// Never 409 -- a 4xx makes the provider retry the thing we discarded.
		expect(second.status).toBe(200);
		expect(await second.json()).toMatchObject({ duplicate: true });
		expect(rows("SELECT * FROM webhook_events").length).toBe(1);
	});

	test("no message id means no dedupe, because two identical bodies can be two events", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "gh", preset: "github" });

		await serve(post("/h/lisa/gh", "{}", { headers: { "X-GitHub-Event": "ping" } }));
		await serve(post("/h/lisa/gh", "{}", { headers: { "X-GitHub-Event": "ping" } }));

		expect(rows("SELECT * FROM webhook_events").length).toBe(2);
	});

	test("stripe's preset reads both fields out of the body by path", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "st", preset: "stripe" });

		await serve(
			post("/h/lisa/st", '{"id":"evt_1","type":"charge.succeeded"}', {
				headers: { "Content-Type": "application/json" },
			}),
		);

		const event = onlyEvent();
		expect(event.event_type).toBe("charge.succeeded");
		expect(event.dedupe_key).toBe("evt_1");
	});

	test("routing_key is extracted by configured path, so per-entity filtering is a query", async () => {
		// 17TRACK echoes a caller-supplied tag in every push; this is the difference
		// between filing events per parcel and pulling every body to find three.
		await seedReceiver(env, {
			inbox: "lisa",
			slug: "t17",
			extract: { routingKeyPath: "data.tag", eventTypePath: "event" },
		});

		await serve(
			post("/h/lisa/t17", '{"event":"TRACKING_UPDATED","data":{"tag":"parcel-42"}}', {
				headers: { "Content-Type": "application/json" },
			}),
		);

		const event = onlyEvent();
		expect(event.routing_key).toBe("parcel-42");
		expect(event.event_type).toBe("TRACKING_UPDATED");
	});

	test("body-hash dedupe collapses a retry inside the window and stores it after", async () => {
		await seedReceiver(env, {
			inbox: "lisa",
			slug: "hash",
			extract: { dedupe: "body-hash", dedupeWindowMs: 60_000 },
		});

		const first = await serve(post("/h/lisa/hash", '{"same":true}'));
		const second = await serve(post("/h/lisa/hash", '{"same":true}'));
		expect(await second.json()).toMatchObject({ duplicate: true });
		expect(rows("SELECT * FROM webhook_events").length).toBe(1);

		// Age the stored row past the window. Outside it the same bytes are a new
		// event again -- this narrows the duplicate window, it does not close it.
		env.DB.raw
			.query("UPDATE webhook_events SET created_at = ?, dedupe_key = ?")
			.run(Date.now() - 3_600_000, "stale-key");
		const later = await serve(post("/h/lisa/hash", '{"same":true}'));

		expect(later.status).toBe(200);
		expect(await later.json()).not.toMatchObject({ duplicate: true });
		expect(rows("SELECT * FROM webhook_events").length).toBe(2);
		expect(first.status).toBe(200);
	});

	test("a malformed extraction path is not fatal -- the event still stores", async () => {
		await seedReceiver(env, {
			inbox: "lisa",
			slug: "bad",
			extract: { routingKeyPath: "nope.not.here" },
		});

		const res = await serve(
			post("/h/lisa/bad", '{"a":1}', { headers: { "Content-Type": "application/json" } }),
		);

		expect(res.status).toBe(200);
		expect(onlyEvent().routing_key).toBeNull();
	});
});

describe("verification is not stubbed silently", () => {
	test("a receiver asking for a mode this build cannot honour fails closed", async () => {
		// Writing verified=1 for a signature no code checked would be a lie in the
		// database. Until phase 2 lands the verifier, the honest answer is 401 --
		// and the request is still stored, because a rejected event is how you
		// debug a rotated secret.
		await seedReceiver(env, { inbox: "lisa", slug: "signed", authMode: "stripe" });

		const res = await serve(post("/h/lisa/signed", "{}"));

		expect(res.status).toBe(401);
		const event = onlyEvent();
		expect(event.status).toBe("rejected");
		expect(event.verified).toBe(0);
	});

	test("a rejected event keeps a short retention -- it is evidence, not an archive", async () => {
		await seedReceiver(env, {
			inbox: "lisa",
			slug: "signed",
			authMode: "stripe",
			retentionDays: 120,
		});

		await serve(post("/h/lisa/signed", "{}"));

		const event = onlyEvent();
		const days = Math.round((event.expires_at - event.created_at) / 86_400_000);
		expect(days).toBe(7);
	});

	test("auth_mode none stores with verified NULL, not verified 1", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "open" });

		await serve(post("/h/lisa/open", "{}"));

		const event = onlyEvent();
		expect(event.verified).toBeNull();
		expect(event.status).toBe("queued");
	});
});

describe("responding before the bookkeeping", () => {
	test("counters are bumped off the response path", async () => {
		const id = await seedReceiver(env, { inbox: "lisa", slug: "count" });
		// Hold the counter UPDATE open. Without the gate the fake's synchronous
		// SQLite would land the write before the promise ever yielded, and a
		// deferred bump would be indistinguishable from an inline one.
		const gate = gateStatement(env, "UPDATE webhook_receivers");

		// Zoom allows three seconds and 17TRACK turns a slow response into three
		// more copies, so nothing cosmetic may hold up the acknowledgement.
		const res = await serve(post("/h/lisa/count", "{}"));

		expect(res.status).toBe(200);
		expect(ctx.waits.length).toBe(1);
		expect(rows("SELECT event_count FROM webhook_receivers WHERE id = ?", id)[0].event_count).toBe(
			0,
		);

		gate.release();
		await ctx.settle();

		const row = rows("SELECT * FROM webhook_receivers WHERE id = ?", id)[0];
		expect(row.event_count).toBe(1);
		expect(row.last_event_at).not.toBeNull();
	});

	test("a deduped retry does not bump the counter -- it stored nothing", async () => {
		const id = await seedReceiver(env, { inbox: "lisa", slug: "dupes", preset: "github" });
		const headers = { "X-GitHub-Event": "push", "X-GitHub-Delivery": "one" };

		await serve(post("/h/lisa/dupes", "{}", { headers }));
		await serve(post("/h/lisa/dupes", "{}", { headers }));
		await ctx.settle();

		// Otherwise `hook-get` reports more events than the queue holds, and the
		// first thing anyone does with that number is disbelieve the queue.
		expect(rows("SELECT event_count FROM webhook_receivers WHERE id = ?", id)[0].event_count).toBe(
			1,
		);
		expect(rows("SELECT * FROM webhook_events").length).toBe(1);
	});

	test("retention is stamped at insert from the receiver's own setting", async () => {
		await seedReceiver(env, { inbox: "lisa", slug: "keep", retentionDays: 30 });

		await serve(post("/h/lisa/keep", "{}"));

		const event = onlyEvent();
		expect(Math.round((event.expires_at - event.created_at) / 86_400_000)).toBe(30);
	});
});
