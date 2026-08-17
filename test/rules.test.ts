import { beforeEach, describe, expect, test } from "bun:test";
import { fireRules, findMatchingRules } from "../src/lib/rules";
import type { Drop, WebhookQueueMessage } from "../src/types";
import { makeCtx, makeEnv, type TestCtx, type TestEnv } from "./helpers/env";

// The rules engine decides where mail GOES. A bug here misroutes a drop to the
// wrong address and nothing errors -- no exception, no failed delivery, just a
// stranger's inbox. These tests pin the routing decisions, not the plumbing.

let env: TestEnv;
let ctx: TestCtx;
let sent: WebhookQueueMessage[];

interface SeedRule {
	pattern: string;
	type: "forward" | "webhook";
	target: string;
	scopes?: string;
	headers?: Record<string, string> | null;
	enabled?: number;
	priority?: number;
}

let ruleSeq = 0;

async function seedRule(rule: SeedRule): Promise<string> {
	const id = `rule-${++ruleSeq}`;
	await env.DB.prepare(
		`INSERT INTO drop_rules (id, pattern, type, scopes, target, headers, enabled, priority, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			id,
			rule.pattern,
			rule.type,
			rule.scopes ?? "all",
			rule.target,
			rule.headers ? JSON.stringify(rule.headers) : null,
			rule.enabled ?? 1,
			rule.priority ?? 0,
			// created_at is the ORDER BY tiebreaker, so seeding order must be stable.
			ruleSeq,
		)
		.run();
	return id;
}

function makeDrop(overrides: Partial<Drop> = {}): Drop {
	return {
		id: "drop-abc123",
		inbox: "lisa",
		channel: "email",
		topic: "invoices",
		subject: "Invoice #2847",
		from_addr: "accounting@example.com",
		body_text: "please pay",
		has_attachments: 1,
		attachment_count: 1,
		metadata: JSON.stringify({ auth_method: "email" }),
		created_at: 1_775_112_960_019,
		...overrides,
	} as Drop;
}

/**
 * On the wire the webhook payload is just Record<string, unknown>. This is the
 * shape CLAUDE.md documents under "Webhook Payload", named so the assertions
 * below read as a contract rather than a pile of casts.
 */
interface WebhookPayload {
	event: string;
	drop: Record<string, unknown>;
	rule: { id: string; pattern: string };
	captures: Record<string, string>;
}

function payloadOf(msg: WebhookQueueMessage): WebhookPayload {
	return msg.payload as unknown as WebhookPayload;
}

/** Collect the addresses fireRules asked the forwarder to deliver to. */
function forwarder(seen: string[]) {
	return async (to: string) => {
		seen.push(to);
	};
}

beforeEach(() => {
	sent = [];
	env = makeEnv({
		WEBHOOK_QUEUE: {
			send: async (msg: WebhookQueueMessage) => {
				sent.push(msg);
			},
		} as unknown as TestEnv["WEBHOOK_QUEUE"],
	});
	ctx = makeCtx();
	ruleSeq = 0;
});

describe("pattern matching", () => {
	test('"*" matches every inbox and captures the whole name', async () => {
		await seedRule({ pattern: "*", type: "forward", target: "catch@x.com" });

		for (const inbox of ["lisa", "shop-returns", "a", "hr-invoices"]) {
			const matches = await findMatchingRules(env, inbox, "email");
			expect(matches).toHaveLength(1);
			expect(matches[0].captures).toEqual({ name: inbox });
		}
	});

	test("an exact pattern matches only that inbox, and captures nothing", async () => {
		await seedRule({ pattern: "lisa", type: "forward", target: "lisa@x.com" });

		const hit = await findMatchingRules(env, "lisa", "email");
		expect(hit).toHaveLength(1);
		expect(hit[0].captures).toEqual({});

		// Not a prefix match: "lisa" must not swallow "lisa-invoices" or "lisabeth".
		expect(await findMatchingRules(env, "lisa-invoices", "email")).toHaveLength(0);
		expect(await findMatchingRules(env, "lisabeth", "email")).toHaveLength(0);
	});

	test('prefix pattern "shop-*" captures the suffix', async () => {
		await seedRule({ pattern: "shop-*", type: "forward", target: "s@x.com" });

		const returns = await findMatchingRules(env, "shop-returns", "email");
		expect(returns[0].captures).toEqual({ name: "returns" });

		const eu = await findMatchingRules(env, "shop-eu", "email");
		expect(eu[0].captures).toEqual({ name: "eu" });

		// The hyphen is part of the pattern: "shopping" is not "shop-*".
		expect(await findMatchingRules(env, "shopping", "email")).toHaveLength(0);
		// A bare "shop" has nothing after the hyphen, so it does not match either.
		expect(await findMatchingRules(env, "shop", "email")).toHaveLength(0);
	});

	test('suffix pattern "*-invoices" captures the prefix', async () => {
		await seedRule({ pattern: "*-invoices", type: "forward", target: "ap@x.com" });

		expect((await findMatchingRules(env, "lisa-invoices", "email"))[0].captures).toEqual({
			name: "lisa",
		});
		expect((await findMatchingRules(env, "hr-invoices", "email"))[0].captures).toEqual({
			name: "hr",
		});
		expect(await findMatchingRules(env, "invoices", "email")).toHaveLength(0);
		expect(await findMatchingRules(env, "invoices-hr", "email")).toHaveLength(0);
	});

	test("an infix star captures the middle and requires it to be non-empty", async () => {
		await seedRule({ pattern: "eu*shop", type: "forward", target: "e@x.com" });

		expect((await findMatchingRules(env, "eu-de-shop", "email"))[0].captures).toEqual({
			name: "-de-",
		});
		// prefix+suffix touching, nothing captured -> no match
		expect(await findMatchingRules(env, "eushop", "email")).toHaveLength(0);
	});

	test("matching is case-sensitive on the stored pattern", async () => {
		// Inbox names are normalized to lowercase before they reach the engine, so
		// an uppercase pattern is a misconfiguration that silently never fires.
		await seedRule({ pattern: "Lisa", type: "forward", target: "l@x.com" });
		expect(await findMatchingRules(env, "lisa", "email")).toHaveLength(0);
	});
});

describe("scope filtering", () => {
	test("a rule only fires for a channel in its scopes", async () => {
		await seedRule({ pattern: "*", type: "webhook", target: "https://h/e", scopes: "email" });

		expect(await findMatchingRules(env, "lisa", "email")).toHaveLength(1);
		expect(await findMatchingRules(env, "lisa", "web")).toHaveLength(0);
		expect(await findMatchingRules(env, "lisa", "api")).toHaveLength(0);
	});

	test('"all" matches every channel', async () => {
		await seedRule({ pattern: "*", type: "webhook", target: "https://h/a", scopes: "all" });

		for (const channel of ["email", "web", "api"] as const) {
			expect(await findMatchingRules(env, "lisa", channel)).toHaveLength(1);
		}
	});

	test("a comma-separated scope list is parsed and trimmed", async () => {
		await seedRule({ pattern: "*", type: "webhook", target: "https://h/c", scopes: "email, api" });

		expect(await findMatchingRules(env, "lisa", "email")).toHaveLength(1);
		expect(await findMatchingRules(env, "lisa", "api")).toHaveLength(1);
		expect(await findMatchingRules(env, "lisa", "web")).toHaveLength(0);
	});

	test("disabled rules never match", async () => {
		await seedRule({ pattern: "*", type: "forward", target: "off@x.com", enabled: 0 });
		expect(await findMatchingRules(env, "lisa", "email")).toHaveLength(0);
	});
});

describe("cascading", () => {
	test("ALL matching rules fire, not just the first", async () => {
		await seedRule({ pattern: "*", type: "forward", target: "catch@x.com", scopes: "email" });
		await seedRule({ pattern: "lisa", type: "forward", target: "lisa@x.com", scopes: "email" });
		await seedRule({ pattern: "*-invoices", type: "forward", target: "ap@x.com", scopes: "email" });

		const seen: string[] = [];
		await fireRules(env, ctx, makeDrop({ inbox: "lisa-invoices" }), "email", forwarder(seen));
		await ctx.settle();

		expect(seen.sort()).toEqual(["ap@x.com", "catch@x.com"]);
		// "lisa" is an exact pattern and must NOT match "lisa-invoices".
		expect(seen).not.toContain("lisa@x.com");
	});

	test("higher priority is returned first", async () => {
		await seedRule({ pattern: "*", type: "forward", target: "low@x.com", priority: 0 });
		await seedRule({ pattern: "*", type: "forward", target: "high@x.com", priority: 10 });
		await seedRule({ pattern: "*", type: "forward", target: "mid@x.com", priority: 5 });

		const matches = await findMatchingRules(env, "lisa", "email");
		expect(matches.map((m) => m.rule.target)).toEqual(["high@x.com", "mid@x.com", "low@x.com"]);
	});
});

describe("template substitution", () => {
	test("every documented variable resolves in a forward target", async () => {
		await seedRule({
			pattern: "*",
			type: "forward",
			scopes: "email",
			target: "{inbox}+{name}+{topic}+{from}+{subject}+{drop_id}+{channel}@x.com".replace(/ /g, ""),
		});

		const seen: string[] = [];
		await fireRules(env, ctx, makeDrop(), "email", forwarder(seen));
		await ctx.settle();

		expect(seen).toEqual([
			"lisa+lisa+invoices+accounting@example.com+Invoice #2847+drop-abc123+email@x.com",
		]);
	});

	test("{name} is the wildcard capture, which differs from {inbox}", async () => {
		await seedRule({
			pattern: "shop-*",
			type: "forward",
			scopes: "email",
			target: "jonas+shopping+{name}@example.org",
		});

		const seen: string[] = [];
		await fireRules(env, ctx, makeDrop({ inbox: "shop-returns" }), "email", forwarder(seen));
		await ctx.settle();

		expect(seen).toEqual(["jonas+shopping+returns@example.org"]);
	});

	test("an unknown variable substitutes to empty, it is not left literal", async () => {
		await seedRule({
			pattern: "*",
			type: "forward",
			scopes: "email",
			target: "a{nope}b@x.com",
		});

		const seen: string[] = [];
		await fireRules(env, ctx, makeDrop(), "email", forwarder(seen));
		await ctx.settle();

		expect(seen).toEqual(["ab@x.com"]);
	});

	test("missing drop fields substitute to empty rather than 'null'/'undefined'", async () => {
		await seedRule({
			pattern: "*",
			type: "forward",
			scopes: "email",
			target: "x{topic}{from}{subject}y@x.com",
		});

		const seen: string[] = [];
		await fireRules(
			env,
			ctx,
			makeDrop({ topic: null, from_addr: null, subject: null }),
			"email",
			forwarder(seen),
		);
		await ctx.settle();

		expect(seen).toEqual(["xy@x.com"]);
	});

	test("variables are substituted in webhook headers too", async () => {
		await seedRule({
			pattern: "shop-*",
			type: "webhook",
			target: "https://hooks.example.com/{name}",
			headers: { "X-Inbox": "{inbox}", "X-Which": "{name}", "X-Static": "fixed" },
		});

		await fireRules(env, ctx, makeDrop({ inbox: "shop-eu" }), "email", forwarder([]));
		await ctx.settle();

		expect(sent).toHaveLength(1);
		expect(sent[0].target).toBe("https://hooks.example.com/eu");
		expect(sent[0].headers).toEqual({
			"X-Inbox": "shop-eu",
			"X-Which": "eu",
			"X-Static": "fixed",
		});
	});
});

describe("forward delivery", () => {
	test("a comma-separated target list delivers to each address independently", async () => {
		await seedRule({
			pattern: "*",
			type: "forward",
			scopes: "email",
			target: "a@x.com, b@x.com ,c@x.com",
		});

		const seen: string[] = [];
		await fireRules(env, ctx, makeDrop(), "email", forwarder(seen));
		await ctx.settle();

		expect(seen).toEqual(["a@x.com", "b@x.com", "c@x.com"]);

		const log = env.DB.raw
			.query("SELECT target, status FROM delivery_log ORDER BY target")
			.all() as { target: string; status: string }[];
		expect(log).toEqual([
			{ target: "a@x.com", status: "success" },
			{ target: "b@x.com", status: "success" },
			{ target: "c@x.com", status: "success" },
		]);
	});

	test("forwards only fire on the email channel", async () => {
		// A forward has nowhere to send a web/API drop -- there is no original
		// message to re-send -- so the rule must be skipped, not attempted.
		await seedRule({ pattern: "*", type: "forward", scopes: "all", target: "a@x.com" });

		const seen: string[] = [];
		await fireRules(env, ctx, makeDrop({ channel: "web" }), "web", forwarder(seen));
		await ctx.settle();

		expect(seen).toEqual([]);
		expect(env.DB.raw.query("SELECT COUNT(*) AS n FROM delivery_log").get()).toEqual({ n: 0 });
	});

	test("a failing forward is logged as failed and does not abort the others", async () => {
		await seedRule({ pattern: "*", type: "forward", scopes: "email", target: "bad@x.com" });
		await seedRule({ pattern: "*", type: "forward", scopes: "email", target: "good@x.com" });

		const seen: string[] = [];
		await fireRules(env, ctx, makeDrop(), "email", async (to: string) => {
			if (to === "bad@x.com") throw new Error("mailbox full");
			seen.push(to);
		});
		await ctx.settle();

		expect(seen).toEqual(["good@x.com"]);

		const log = env.DB.raw
			.query("SELECT target, status, error FROM delivery_log ORDER BY target")
			.all() as { target: string; status: string; error: string | null }[];
		expect(log).toEqual([
			{ target: "bad@x.com", status: "failed", error: "mailbox full" },
			{ target: "good@x.com", status: "success", error: null },
		]);
	});

	test("nothing is logged when no rule matches", async () => {
		await seedRule({ pattern: "bob", type: "forward", scopes: "email", target: "bob@x.com" });

		const seen: string[] = [];
		await fireRules(env, ctx, makeDrop({ inbox: "lisa" }), "email", forwarder(seen));
		await ctx.settle();

		expect(seen).toEqual([]);
		expect(env.DB.raw.query("SELECT COUNT(*) AS n FROM delivery_log").get()).toEqual({ n: 0 });
	});
});

describe("webhook enqueue", () => {
	test("the queued payload carries the documented drop shape and parsed metadata", async () => {
		const ruleId = await seedRule({ pattern: "lisa", type: "webhook", target: "https://h/ingest" });

		await fireRules(env, ctx, makeDrop(), "email", forwarder([]));
		await ctx.settle();

		expect(sent).toHaveLength(1);
		const msg = sent[0];
		expect(msg.type).toBe("webhook");
		expect(msg.attempt).toBe(0);
		const payload = payloadOf(msg);
		expect(payload.event).toBe("drop.created");
		expect(payload.drop).toMatchObject({
			id: "drop-abc123",
			inbox: "lisa",
			channel: "email",
			topic: "invoices",
			subject: "Invoice #2847",
			from_addr: "accounting@example.com",
			has_attachments: 1,
			attachment_count: 1,
			created_at: 1_775_112_960_019,
		});
		// metadata is stored as a JSON string but published as an object.
		expect(payload.drop.metadata).toEqual({ auth_method: "email" });
		expect(payload.rule).toEqual({ id: ruleId, pattern: "lisa" });
		expect(payload.captures).toMatchObject({ inbox: "lisa", channel: "email" });
	});

	test("null metadata publishes as null rather than throwing", async () => {
		await seedRule({ pattern: "*", type: "webhook", target: "https://h/n" });

		await fireRules(env, ctx, makeDrop({ metadata: null }), "email", forwarder([]));
		await ctx.settle();

		expect(payloadOf(sent[0]).drop.metadata).toBeNull();
	});

	test("webhooks fire on web and api channels, not just email", async () => {
		await seedRule({ pattern: "*", type: "webhook", target: "https://h/x", scopes: "all" });

		await fireRules(env, ctx, makeDrop({ channel: "web" }), "web", forwarder([]));
		await ctx.settle();

		expect(sent).toHaveLength(1);
		expect(payloadOf(sent[0]).captures.channel).toBe("web");
	});

	test("the delivery_log row is created as queued before the message is sent", async () => {
		await seedRule({ pattern: "*", type: "webhook", target: "https://h/q" });

		await fireRules(env, ctx, makeDrop(), "email", forwarder([]));
		await ctx.settle();

		const log = env.DB.raw
			.query("SELECT id, type, target, status, attempts FROM delivery_log")
			.all() as { id: string; type: string; target: string; status: string; attempts: number }[];
		expect(log).toEqual([
			{ id: sent[0].logId, type: "webhook", target: "https://h/q", status: "queued", attempts: 0 },
		]);
	});
});
