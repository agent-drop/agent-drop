import { describe, expect, test } from "bun:test";
import { handleCompose, handleSend } from "../src/api/send";
import type { Env } from "../src/types";
import {
	attachmentLimitError,
	base64Length,
	ENTRY_TRANSPORT_ALLOWANCE,
	INLINE_FILE_MAX_BYTES,
	jsonByteLength,
	MAX_ATTACHMENT_TOTAL_BYTES,
	MAX_ATTACHMENTS,
	MAX_EMAIL_REQUEST_BYTES,
	MAX_INLINE_ATTACHMENT_BYTES,
	planAttachmentTransport,
	REQUEST_BUDGET_BYTES,
	type TransportPlan,
} from "../tools/lib/attachment-plan";
import { makeEmail, onlyBuilder } from "./helpers/email";
import { jsonRequest, makeBucket, makeEnv } from "./helpers/env";

/**
 * `send-email` decides, per local file, between base64 inside the JSON request
 * and an R2 upload referenced by key. The worker refuses a JSON request over
 * 8 MiB, and base64 inflates by 4/3, so "inline everything under 1 MB" stopped
 * working at about seven such files. These tests push the plan's output through
 * the REAL handlers rather than trusting the planner's own arithmetic.
 */

const PLAIN = { to: "bob@example.com", subject: "Report", text: "see attached" };
const FILE_META = { contentType: "application/octet-stream", inline: false };

function fileOf(size: number, seed: number): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(size);
	for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed) & 0xff;
	return bytes;
}

const nameOf = (i: number) => `part-${i}.bin`;

/** The request as the CLI measures it: every entry bare, no dataBase64 or r2Key yet. */
function skeletonBytes(body: Record<string, unknown>, count: number): number {
	const attachments = Array.from({ length: count }, (_, i) => ({
		filename: nameOf(i),
		...FILE_META,
	}));
	return jsonByteLength({ ...body, attachments });
}

/**
 * What the CLI puts on the wire for a plan: base64 for `inline`, an R2 key (the
 * bytes pre-seeded into the fake bucket, where the presigned PUT would have left
 * them) for `upload`. Same field names the CLI sends.
 */
function wireFor(body: Record<string, unknown>, files: Uint8Array[], plan: TransportPlan) {
	const objects: Record<string, Uint8Array> = {};
	const attachments = files.map((bytes, i) => {
		const entry: Record<string, unknown> = { filename: nameOf(i), ...FILE_META };
		if (plan.transports[i] === "inline") {
			entry.dataBase64 = Buffer.from(bytes).toString("base64");
		} else {
			const r2Key = `outbound/temp/lisa/01JTESTKEY0000000000000${i}/${nameOf(i)}`;
			objects[r2Key] = bytes;
			entry.r2Key = r2Key;
		}
		return entry;
	});
	return { request: { ...body, attachments }, bucket: makeBucket(objects) };
}

function planFor(body: Record<string, unknown>, files: Uint8Array[], forceUpload = false) {
	return planAttachmentTransport(
		files.map((f) => f.byteLength),
		{ baseBytes: skeletonBytes(body, files.length), forceUpload },
	);
}

const sevenMegabytes = () => Array.from({ length: 7 }, (_, i) => fileOf(1_000_000, i));
const inlined = (plan: TransportPlan) => plan.transports.filter((t) => t === "inline").length;

async function sendThrough(
	handler: typeof handleSend,
	route: "send" | "compose",
	body: Record<string, unknown>,
	files: Uint8Array[],
	plan: TransportPlan,
) {
	const { request, bucket } = wireFor(body, files, plan);
	const email = makeEmail();
	const env = makeEnv({ BUCKET: bucket, EMAIL: email as unknown as Env["EMAIL"] });
	const response = await handler(
		jsonRequest(`https://drop.test/api/${route}/lisa`, request),
		env,
		"lisa",
	);
	return { response, email, request };
}

describe("planAttachmentTransport: the request budget", () => {
	test("does not inline seven 1 MB files into one request", () => {
		const plan = planFor(PLAIN, sevenMegabytes());
		expect(inlined(plan)).toBeLessThan(7);
		expect(plan.transports.filter((t) => t === "upload").length).toBeGreaterThan(0);
		expect(plan.requestBytes).toBeLessThanOrEqual(REQUEST_BUDGET_BYTES);
	});

	test("the request it produces for seven 1 MB files is accepted by /api/send", async () => {
		const files = sevenMegabytes();
		const plan = planFor(PLAIN, files);
		const { response, email } = await sendThrough(handleSend, "send", PLAIN, files, plan);

		expect(response.status).toBe(200);
		const sent = onlyBuilder(email).attachments ?? [];
		expect(sent).toHaveLength(7);
		for (const [i, a] of sent.entries()) {
			expect(new Uint8Array(a.content as ArrayBuffer)).toEqual(files[i]);
		}
	});

	test("--dry-run (/api/compose) accepts the same plan", async () => {
		const files = sevenMegabytes();
		const plan = planFor(PLAIN, files);
		const { response } = await sendThrough(handleCompose, "compose", PLAIN, files, plan);
		expect(response.status).toBe(200);
	});

	test("its estimate is an upper bound on the bytes actually sent", () => {
		const files = [...sevenMegabytes(), fileOf(10, 9), fileOf(400_000, 8)];
		const plan = planFor(PLAIN, files);
		const { request } = wireFor(PLAIN, files, plan);
		expect(jsonByteLength(request)).toBeLessThanOrEqual(plan.requestBytes);
	});

	test("the body spends the same budget as the attachments", async () => {
		// Alone, these files would mostly ride inline. Beside a 6.5 MiB body they
		// cannot: inlining even one would take the request past 8 MiB.
		const body = { ...PLAIN, text: "x".repeat(6.5 * 1024 * 1024) };
		const files = sevenMegabytes();
		const plan = planFor(body, files);
		expect(inlined(plan)).toBe(0);

		const { response, email } = await sendThrough(handleSend, "send", body, files, plan);
		expect(response.status).toBe(200);
		expect(onlyBuilder(email).attachments).toHaveLength(7);
	});

	test("small files go inline first; the email keeps the order the user gave", () => {
		// Room for exactly the three small ones: 3 entries of allowance plus their
		// base64, and not a byte more for the 900 KB one.
		const sizes = [900_000, 30_000, 1_000_000, 30_000, 30_000];
		const baseBytes = 1_000;
		const budget = baseBytes + sizes.length * ENTRY_TRANSPORT_ALLOWANCE + 3 * base64Length(30_000);
		const plan = planAttachmentTransport(sizes, { baseBytes, budget });
		expect(plan.transports).toEqual(["upload", "inline", "upload", "inline", "inline"]);
		expect(plan.requestBytes).toBe(budget);
	});

	test("once a file does not fit, no larger one is inlined either", () => {
		const sizes = [500_000, 100_000, 300_000, 200_000];
		const baseBytes = 0;
		const budget =
			sizes.length * ENTRY_TRANSPORT_ALLOWANCE + base64Length(100_000) + base64Length(200_000);
		const plan = planAttachmentTransport(sizes, { baseBytes, budget });
		expect(plan.transports).toEqual(["upload", "inline", "upload", "inline"]);
	});

	test("a file over 1 MB uploads even when the budget has room for it", () => {
		const plan = planAttachmentTransport([INLINE_FILE_MAX_BYTES + 1, INLINE_FILE_MAX_BYTES], {
			baseBytes: 0,
		});
		expect(plan.transports).toEqual(["upload", "inline"]);
	});

	test("--upload still presigns everything", () => {
		const plan = planAttachmentTransport([10, 20, 30], { baseBytes: 0, forceUpload: true });
		expect(plan.transports).toEqual(["upload", "upload", "upload"]);
	});

	test("no local files is an empty plan", () => {
		const plan = planAttachmentTransport([], { baseBytes: 123 });
		expect(plan).toEqual({ transports: [], requestBytes: 123 });
	});
});

describe("attachmentLimitError: refused before any upload", () => {
	const ok = { count: 3, localBytes: 1_000, requestBytes: 10_000 };

	test("a send inside every limit goes ahead", () => {
		expect(attachmentLimitError(ok)).toBeNull();
		expect(attachmentLimitError({ ...ok, localBytes: MAX_ATTACHMENT_TOTAL_BYTES })).toBeNull();
		expect(attachmentLimitError({ ...ok, count: MAX_ATTACHMENTS })).toBeNull();
	});

	test("over the 16 MiB decoded budget", () => {
		const error = attachmentLimitError({ ...ok, localBytes: MAX_ATTACHMENT_TOTAL_BYTES + 1 });
		expect(error).toContain("16.0 MiB");
	});

	test("more attachments than the server accepts", () => {
		expect(attachmentLimitError({ ...ok, count: MAX_ATTACHMENTS + 1 })).toContain(
			`at most ${MAX_ATTACHMENTS}`,
		);
	});

	test("a body too large to send even with every file in R2", () => {
		const body = { ...PLAIN, text: "x".repeat(MAX_EMAIL_REQUEST_BYTES) };
		const plan = planAttachmentTransport([10], { baseBytes: skeletonBytes(body, 1) });
		expect(plan.transports).toEqual(["upload"]);
		const error = attachmentLimitError({ ...ok, requestBytes: plan.requestBytes });
		expect(error).toContain("8.0 MiB");
	});

	test("the server 413s the same send the check refuses", async () => {
		// Pins that the CLI's 16 MiB check matches the worker's: 17 x 1 MB, every
		// one in R2, is refused by both.
		const files = Array.from({ length: 17 }, (_, i) => fileOf(1_000_000, i));
		const plan = planFor(PLAIN, files, true);
		expect(
			attachmentLimitError({
				count: files.length,
				localBytes: files.reduce((n, f) => n + f.byteLength, 0),
				requestBytes: plan.requestBytes,
			}),
		).not.toBeNull();
		const { response } = await sendThrough(handleSend, "send", PLAIN, files, plan);
		expect(response.status).toBe(413);
	});
});

describe("the CLI's budget against the server's limits", () => {
	test("the budget sits under the cap, and one inline file under the per-file limit", () => {
		expect(REQUEST_BUDGET_BYTES).toBeLessThan(MAX_EMAIL_REQUEST_BYTES);
		expect(INLINE_FILE_MAX_BYTES).toBeLessThan(MAX_INLINE_ATTACHMENT_BYTES);
	});
});
