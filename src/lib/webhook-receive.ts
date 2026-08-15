/**
 * The public webhook endpoint: {domain}/h/{box}/{slug}[/anything/after].
 *
 * This is the only unauthenticated WRITE surface in the system, and the order of
 * operations below is the contract, not a style choice:
 *
 *   resolve receiver -> method -> size cap -> read raw BYTES and hash them ->
 *   handshake -> verify -> extract -> store -> respond
 *
 * Two things about it are worth stating out loud. The body is read once, as
 * bytes, and hashed before anything decodes it -- a consumer holding the
 * provider's secret has to be able to verify a signature from what we stored,
 * and that is only true if we never touched the bytes. And the response goes out
 * the moment the row lands: providers give us seconds, and one of them turns any
 * non-200 into three more copies over the next hundred minutes, so anything
 * synchronous after the insert is a bug waiting for a slow day.
 */

import { fanOutEvent } from "./hook-fanout";
import { normalizeInbox, normalizeSlug } from "./normalize";
import { recordAuthFailure } from "./ratelimit";
import {
	decodeUtf8,
	jsonConfig,
	parseJson,
	secretHeaders,
	secretParams,
	sha256Hex,
} from "./webhook-body";
import { extractFields, type ExtractConfig } from "./webhook-extract";
import { detectHandshake } from "./webhook-handshake";
import { bumpReceiverCounters, collectHeaders, collectQuery, storeEvent } from "./webhook-store";
import { verifyWebhook } from "./webhook-verify";
import type { Env, WebhookReceiver } from "../types";

export { HOOK_PREFIX } from "./webhook-defs";

function fail(status: number, error: string, headers: Record<string, string> = {}): Response {
	return Response.json({ error }, { status, headers });
}

/**
 * Resolve `/h/{box}/{slug}` to a receiver, or to the status that says why not.
 *
 * Unregistered, disabled and expired are three DIFFERENT answers, and keeping
 * them apart is the single most useful diagnostic when a provider reports "your
 * endpoint is failing" -- it answers *did it reach a receiver at all*. But an
 * unregistered slug stays 404 rather than 403: 403 means "this exists and you
 * may not have it", which would confirm the slug is real to anyone probing, and
 * for a receiver whose URL IS its credential that is a yes/no oracle.
 *
 * A rotated receiver still answers on its old slug until the grace window ends,
 * because a dashboard cutover must not drop traffic mid-flight.
 */
async function resolveReceiver(
	env: Env,
	inbox: string,
	slug: string,
	now: number,
): Promise<WebhookReceiver | Response> {
	const receiver = await env.DB.withSession("first-unconstrained")
		.prepare(
			`SELECT * FROM webhook_receivers
			  WHERE inbox = ?
			    AND (slug = ? OR (previous_slug = ? AND previous_slug_expires_at > ?))
			  LIMIT 1`,
		)
		.bind(inbox, slug, slug, now)
		.first<WebhookReceiver>();

	if (!receiver) return fail(404, "no such receiver");
	if (!receiver.enabled) return fail(403, "receiver disabled");
	if (receiver.expires_at && receiver.expires_at <= now) return fail(410, "receiver expired");
	return receiver;
}

function checkMethod(receiver: WebhookReceiver, method: string): Response | null {
	const allowed = (receiver.allowed_methods || "POST")
		.split(",")
		.map((m) => m.trim().toUpperCase())
		.filter(Boolean);
	if (allowed.includes(method)) return null;
	return fail(405, `method ${method} not allowed`, { Allow: allowed.join(", ") });
}

/** What the provider gets back once we have stored its request. */
function ack(receiver: WebhookReceiver, payload: Record<string, unknown>): Response {
	const status = receiver.response_status ?? 200;
	if (receiver.response_body === null || receiver.response_body === undefined) {
		return Response.json(payload, { status });
	}
	return new Response(receiver.response_body, {
		status,
		headers: { "Content-Type": receiver.response_content_type || "text/plain; charset=utf-8" },
	});
}

/**
 * What was stored, for a caller that drove this path itself.
 *
 * A provider learns the event id from the response body -- but a receiver with a
 * custom `response_body` answers whatever it was configured to, and `queue-put`
 * still needs to know which row it just made. An out-param rather than a changed
 * return type, so the public endpoint's behaviour is untouched.
 */
export interface ReceiveOutcome {
	id?: string;
	duplicate?: boolean;
	status?: string;
}

/**
 * Serve one request to the public receiver endpoint. Called only for paths under
 * /{HOOK_PREFIX}/. Always returns a Response -- never throws at the provider.
 *
 * The catch-all is the 503 row of the status table, and it has to sit out here
 * rather than around the insert alone: a D1 outage during the receiver lookup is
 * just as much our failure as one during the write, and an escaping exception
 * would hand the provider a runtime error page instead of the retry signal it
 * knows how to act on.
 */
export async function serveWebhook(
	request: Request,
	env: Env,
	url: URL,
	ctx: ExecutionContext,
	outcome?: ReceiveOutcome,
): Promise<Response> {
	try {
		return await receive(request, env, url, ctx, outcome);
	} catch (err) {
		console.error("webhook receive failed:", err);
		return fail(503, "could not store event");
	}
}

async function receive(
	request: Request,
	env: Env,
	url: URL,
	ctx: ExecutionContext,
	outcome?: ReceiveOutcome,
): Promise<Response> {
	const now = Date.now();
	const segs = url.pathname.split("/").filter(Boolean); // ["h", box, slug, ...subpath]
	const inbox = segs[1] ? normalizeInbox(segs[1]) : null;
	const slug = segs[2] ? normalizeSlug(segs[2]) : null;
	// A name that cannot be normalized cannot name a row, so it is unregistered.
	if (!inbox || !slug) return fail(404, "no such receiver");

	const resolved = await resolveReceiver(env, inbox, slug, now);
	if (resolved instanceof Response) return resolved;
	const receiver = resolved;

	const methodDenied = checkMethod(receiver, request.method);
	if (methodDenied) return methodDenied;

	const maxBytes = receiver.max_body_bytes ?? 1_048_576;
	const declared = Number(request.headers.get("Content-Length") ?? Number.NaN);
	if (Number.isFinite(declared) && declared > maxBytes) return fail(413, "body too large");

	// The one read of the body, as bytes. Everything downstream works from these.
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await request.arrayBuffer());
	} catch {
		return fail(400, "could not read request body");
	}
	// A chunked request declares no length, so the real check is this one.
	if (bytes.byteLength > maxBytes) return fail(413, "body too large");

	const sha256 = await sha256Hex(bytes);
	const text = decodeUtf8(bytes);
	const contentType = request.headers.get("Content-Type");
	const subpath = segs.length > 3 ? segs.slice(3).join("/") : null;

	// Everything a stored event needs regardless of what we decide the request was.
	// Redaction reaches the query string as well as the headers, because a shared
	// secret is no less a credential for arriving in a `?token=`.
	const envelope = {
		receiver,
		method: request.method,
		subpath,
		headers: collectHeaders(request.headers, secretHeaders(receiver)),
		query: collectQuery(url, secretParams(receiver)),
		contentType,
		bytes,
		text,
		sha256,
		remoteIp: request.headers.get("CF-Connecting-IP"),
		country: request.headers.get("CF-IPCountry"),
		userAgent: request.headers.get("User-Agent"),
		now,
	};

	// The handshake runs BEFORE verification and NEVER falls through to it. A
	// provider sends its challenge before any secret has been agreed, so a
	// handshake that had to pass a signature check first would be a receiver that
	// can never be set up.
	const handshake = await detectHandshake({
		receiver,
		headers: request.headers,
		url,
		method: request.method,
		subpath,
		bytes,
		text,
		contentType,
	});
	if (handshake) {
		// Stored because "the provider says my URL failed validation" is the number
		// one thing you will need to debug and this request is the only evidence --
		// but never deduped, so a Zoom re-validation 72 hours later is its own row.
		//
		// A storage failure does NOT fail the handshake. Everywhere else a write we
		// could not complete has to become a 503, because the provider is trusting
		// us to have kept its event. Here there is no event to keep: the answer is
		// the entire product, it does not depend on the row, and losing an operator's
		// endpoint validation because the audit log hiccuped helps nobody.
		await storeEvent(env, {
			...envelope,
			extracted: {
				eventType: handshake.eventType,
				routingKey: null,
				dedupeKey: null,
				dedupeAlternates: [],
				dedupeWindowMs: null,
			},
			verified: null,
			status: "handshake",
		})
			.then((stored) => {
				if (outcome) {
					outcome.id = stored.id;
					outcome.status = "handshake";
				}
			})
			.catch((err: unknown) => console.error("handshake event not stored:", err));
		return handshake.response;
	}

	// Verification reads `bytes` -- the same array that was hashed above, never the
	// decoded text and never a re-encode of it. `verified` is three-valued: 1 pass,
	// 0 fail, null for a receiver that asked for nothing.
	const verdict = await verifyWebhook({
		receiver,
		headers: request.headers,
		url,
		method: request.method,
		bytes,
		now,
	});
	const status = verdict.verified === 0 ? "rejected" : "queued";
	if (verdict.reason) {
		// The reason goes to the operator's logs and nowhere near the response: a
		// caller probing for a working secret learns only that it failed.
		console.warn(`webhook rejected ${receiver.inbox}/${receiver.slug}: ${verdict.reason}`);
	}

	const extracted = extractFields({
		preset: receiver.preset,
		config: jsonConfig<ExtractConfig>(receiver.extract_config),
		headers: request.headers,
		body: parseJson(text, contentType),
		bodySha256: sha256,
		now,
	});

	// A throw from here is our failure and becomes the 503 the caller's wrapper
	// returns -- the ONE case where a provider should retry. Every caller mistake
	// above answered 4xx instead, so it stops and shows an error in its dashboard.
	const stored = await storeEvent(env, {
		...envelope,
		extracted,
		verified: verdict.verified,
		status,
	});
	if (outcome) {
		outcome.id = stored.id;
		outcome.duplicate = stored.duplicate;
		outcome.status = stored.duplicate ? "duplicate" : status;
	}

	if (status === "rejected") {
		// A bad signature is a guess at a credential, so it burns a token from the
		// same bucket a bad API key would. The event is stored either way -- a
		// rejected event is how you debug a rotated secret.
		if (!(await recordAuthFailure(env, request))) {
			return fail(429, "too many failed authentication attempts", { "Retry-After": "60" });
		}
		return fail(401, "signature verification failed");
	}

	// Counters are cosmetic and rule firing can take as long as it likes; neither
	// is allowed to hold up the acknowledgement. A duplicate does not count: it
	// stored nothing, and a counter that disagrees with the queue it describes is
	// worse than no counter -- nor does it fan out, because re-delivering an event
	// we deliberately discarded is the same lie one layer along.
	//
	// This is reached only by an ACCEPTED event. A handshake returned above and a
	// refusal returned a line ago, which is the point: a rejected row is not a
	// delivery, so `payload_mode: passthrough` can never re-deliver one.
	if (!stored.duplicate) {
		ctx.waitUntil(
			bumpReceiverCounters(env, receiver.id, now).catch((err: unknown) =>
				console.error("receiver counter update failed:", err),
			),
		);
		ctx.waitUntil(
			fanOutEvent(env, ctx, receiver, stored.event).catch((err: unknown) =>
				console.error(`onward delivery failed for ${stored.id}:`, err),
			),
		);
	}

	// A duplicate is never a 409: a 4xx makes the provider retry the thing we
	// deliberately discarded.
	return ack(
		receiver,
		stored.duplicate ? { ok: true, id: stored.id, duplicate: true } : { ok: true, id: stored.id },
	);
}
