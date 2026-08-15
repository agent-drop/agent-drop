/**
 * The setup handshake: answering the challenge a provider makes before it will
 * accept a URL at all.
 *
 * Three things about this module are contract rather than style.
 *
 * It runs BEFORE verification and never falls through to it. A handshake is how
 * a provider decides whether the endpoint is real, and it is sent before any
 * secret has been agreed -- Meta signs nothing, Slack's `url_verification`
 * predates the signing secret being usable, and Zoom's CRC arrives with a
 * signature computed from a token you are in the middle of configuring. A
 * handshake that had to pass signature verification first would be a receiver
 * that can never be set up.
 *
 * A handler returns null to mean "this is not a handshake" -- an ordinary
 * delivery to a receiver that also does handshakes, which then takes the normal
 * verify-and-store path. It returns a result to mean "this was one, answered,
 * done", including when the answer is a rejection: a wrong Meta verify token is
 * a failed handshake, not an event.
 *
 * And the answer is never the receiver's configured `response_body`. What comes
 * back is dictated by the provider -- the challenge verbatim, or the hash it
 * asked for -- and a receiver that overrode it would fail its own setup.
 */

import { constantTimeEqual } from "./compare";
import { jsonConfig } from "./webhook-body";
import { hmacBytes, toHex, utf8 } from "./webhook-crypto";
import type { WebhookReceiver } from "../types";

export interface HandshakeInput {
	receiver: WebhookReceiver;
	headers: Headers;
	url: URL;
	method: string;
	/** Anything after `/h/{box}/{slug}`, for the `static` predicate. */
	subpath: string | null;
	/** The bytes exactly as they arrived. `echo` replies with these unmodified. */
	bytes: Uint8Array;
	/** The decoded body -- null when the bytes were not valid UTF-8. */
	text: string | null;
	contentType: string | null;
}

export interface HandshakeResult {
	response: Response;
	/** Stored as `event_type`, so a peek says what the request was at a glance. */
	eventType: string;
}

/** A `static` receiver answers only requests matching every condition it sets. */
export interface StaticPredicate {
	method?: string;
	subpath?: string;
	query?: Record<string, string>;
	header?: Record<string, string>;
	bodyContains?: string;
}

/** The receiver's `handshake_config` JSON blob. Every field is optional by mode. */
export interface HandshakeConfig {
	/** `meta`: the verify token you typed into the provider's dashboard. */
	token?: string;
	/** `zoom`: the webhook secret token. Accepted as the `meta` token as well. */
	secret?: string;
	/** `echo`: the largest body still treated as a challenge. */
	maxBytes?: number;
	/** `static`: what to match, and the fixed answer to give. */
	when?: StaticPredicate;
	status?: number;
	body?: string;
	contentType?: string;
}

const TEXT = "text/plain; charset=utf-8";

function text(body: BodyInit, status = 200, contentType = TEXT): Response {
	return new Response(body, { status, headers: { "Content-Type": contentType } });
}

function fail(status: number, error: string, eventType: string): HandshakeResult {
	return { response: Response.json({ error }, { status }), eventType };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a body that is shaped like a JSON object or array.
 *
 * Deliberately looser than the extractor's parse, which insists on a JSON
 * content-type: detection here IS the type check (`type === "url_verification"`
 * either matches or it does not), so a provider that mislabels its content-type
 * must still be able to complete its own setup. And deliberately narrower in the
 * other direction -- a bare `42` or `"hi"` is valid JSON but is not a payload, and
 * treating it as one would stop `echo` answering a numeric challenge.
 */
function parseObject(body: string | null): unknown {
	if (body === null) return undefined;
	const trimmed = body.trimStart();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	try {
		return JSON.parse(body);
	} catch {
		return undefined;
	}
}

type Handler = (
	input: HandshakeInput,
	cfg: HandshakeConfig,
) => HandshakeResult | null | Promise<HandshakeResult | null>;

const META_EVENT = "meta.url_verification";
const SLACK_EVENT = "url_verification";
const ZOOM_EVENT = "endpoint.url_validation";

/**
 * Meta's verification request, covering Facebook, WhatsApp, Instagram and
 * Threads. A GET carrying `hub.mode=subscribe`, and the answer is
 * `hub.challenge` as a bare body -- not JSON, not quoted, nothing around it.
 *
 * A wrong `hub.verify_token` answers 403 rather than falling through. Falling
 * through would store the probe as an ordinary event and hand Meta a cheerful
 * `{"ok":true}` that is not the challenge, so the dashboard reports a failure
 * with nothing in our logs that looks like a handshake at all.
 */
const meta: Handler = (input, cfg) => {
	if (input.method !== "GET") return null;
	const params = input.url.searchParams;
	if (params.get("hub.mode") !== "subscribe") return null;
	const challenge = params.get("hub.challenge");
	if (challenge === null) return null;

	const expected = cfg.token ?? cfg.secret;
	if (!expected) return fail(503, "handshake token not configured", META_EVENT);
	if (!constantTimeEqual(params.get("hub.verify_token") ?? "", expected)) {
		return fail(403, "hub.verify_token mismatch", META_EVENT);
	}
	return { response: text(challenge), eventType: META_EVENT };
};

/** Slack's `url_verification`. JSON back is one of the three shapes it accepts. */
const slack: Handler = (input) => {
	if (input.method !== "POST") return null;
	const body = parseObject(input.text);
	if (!isRecord(body) || body.type !== SLACK_EVENT) return null;
	if (typeof body.challenge !== "string") {
		return fail(400, "url_verification carried no challenge", SLACK_EVENT);
	}
	return { response: Response.json({ challenge: body.challenge }), eventType: SLACK_EVENT };
};

/**
 * Zoom's challenge-response check: HMAC-SHA256 of `plainToken`, keyed by the
 * webhook secret token, hex, inside a JSON object that echoes the plain token
 * back beside it. Confirmed against developers.zoom.us on 2026-08-15.
 *
 * This is not a one-time setup step -- Zoom re-runs it every 72 hours and
 * disables the endpoint after six consecutive failures, so a receiver that
 * loses its secret goes quiet days later for no visible reason. That is also
 * why a missing secret answers 503 rather than 400: it is our misconfiguration,
 * and 503 is the one status that makes the provider come back and try again
 * once the operator has fixed it.
 */
const zoom: Handler = async (input, cfg) => {
	if (input.method !== "POST") return null;
	const body = parseObject(input.text);
	if (!isRecord(body) || body.event !== ZOOM_EVENT) return null;

	const payload = isRecord(body.payload) ? body.payload : null;
	const plainToken = typeof payload?.plainToken === "string" ? payload.plainToken : null;
	if (!plainToken) return fail(400, "url_validation carried no plainToken", ZOOM_EVENT);

	const secret = cfg.secret ?? cfg.token;
	if (!secret) return fail(503, "handshake secret not configured", ZOOM_EVENT);

	const encryptedToken = toHex(await hmacBytes(utf8(secret), utf8(plainToken)));
	return { response: Response.json({ plainToken, encryptedToken }), eventType: ZOOM_EVENT };
};

/** Largest body `echo` will treat as a challenge rather than as an event. */
const ECHO_LIMIT = 256;

/**
 * The catch-all for providers that just want their own bytes back. Bounded on
 * both sides on purpose: a JSON object or array is a real payload and must reach
 * the queue, and so is anything longer than the limit. Everything left is a short
 * opaque token, which is what this kind of challenge always is.
 */
const echo: Handler = (input, cfg) => {
	const limit = cfg.maxBytes ?? ECHO_LIMIT;
	if (input.bytes.byteLength === 0 || input.bytes.byteLength > limit) return null;
	if (parseObject(input.text) !== undefined) return null;
	return {
		response: text(input.bytes, 200, input.contentType || TEXT),
		eventType: "echo",
	};
};

function matchesPredicate(input: HandshakeInput, when: StaticPredicate): boolean {
	if (when.method && when.method.toUpperCase() !== input.method) return false;
	if (when.subpath !== undefined && when.subpath !== (input.subpath ?? "")) return false;
	for (const [key, value] of Object.entries(when.query ?? {})) {
		if (!constantTimeEqual(input.url.searchParams.get(key) ?? "", value)) return false;
	}
	for (const [name, value] of Object.entries(when.header ?? {})) {
		if (!constantTimeEqual(input.headers.get(name) ?? "", value)) return false;
	}
	if (when.bodyContains && !(input.text ?? "").includes(when.bodyContains)) return false;
	return true;
}

/**
 * A fixed answer to a configured request shape, for the providers whose setup
 * step is neither of the three above.
 *
 * An empty predicate matches NOTHING rather than everything. Matching everything
 * would turn the whole receiver into a static responder and silently divert every
 * real delivery into `handshake` -- the registration path refuses to create one,
 * and this is the second half of that gate.
 */
const staticReply: Handler = (input, cfg) => {
	const when = cfg.when;
	if (!when || Object.keys(when).length === 0) return null;
	if (!matchesPredicate(input, when)) return null;
	return {
		response: text(cfg.body ?? "", cfg.status ?? 200, cfg.contentType || TEXT),
		eventType: "static",
	};
};

/**
 * The dispatch table. `SUPPORTED_HANDSHAKE_MODES` is derived from its keys, so a
 * mode the registration path accepts and a mode this file implements cannot
 * drift: one that existed only in the list would be registerable and then never
 * answer, and one that existed only here would be unreachable.
 */
export const HANDSHAKES: Record<string, Handler> = {
	meta,
	slack,
	zoom,
	echo,
	static: staticReply,
};

export const HANDSHAKE_MODES = Object.keys(HANDSHAKES);

/**
 * Is this request a handshake? Returns the answer to send, or null to let the
 * normal verify-and-store path have it.
 */
export async function detectHandshake(input: HandshakeInput): Promise<HandshakeResult | null> {
	const mode = input.receiver.handshake_mode || "none";
	if (mode === "none") return null;

	const handler = HANDSHAKES[mode];
	if (!handler) {
		// Only reachable for a row written when the mode still existed. Preserving
		// the request is strictly better than inventing an answer for it.
		console.warn(`handshake_mode '${mode}' is not implemented; treating as a delivery`);
		return null;
	}
	return await handler(input, jsonConfig<HandshakeConfig>(input.receiver.handshake_config) ?? {});
}
