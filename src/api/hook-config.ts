/**
 * Receiver configuration: what a caller may set, and what we hand back.
 *
 * The asymmetry is deliberate. `auth_config` holds a live provider secret, so it
 * goes IN through create and PATCH and never comes back OUT -- a list API that
 * returns secrets is one screen-share away from being a leak. The caller learns
 * `secret_set: true` and rotates by writing a new one.
 */

import { normalizeSlug } from "../lib/normalize";
import { isKnownPreset, presetNames } from "../lib/webhook-extract";
import type { HandshakeConfig } from "../lib/webhook-handshake";
import {
	hookUrl,
	slugSuffix,
	SUPPORTED_AUTH_MODES,
	SUPPORTED_HANDSHAKE_MODES,
} from "../lib/webhook-defs";
import type { Env, WebhookReceiver } from "../types";

export interface CreateBody {
	inbox?: string;
	/** A base name; a random suffix is appended to it. */
	name?: string;
	/** An exact slug, used verbatim -- no suffix. */
	slug?: string;
	label?: string;
	authMode?: string;
	authConfig?: Record<string, unknown>;
	handshakeMode?: string;
	handshakeConfig?: Record<string, unknown>;
	preset?: string;
	extract?: Record<string, unknown>;
	responseStatus?: number;
	responseBody?: string;
	responseContentType?: string;
	methods?: string;
	maxBodyBytes?: number;
	retentionDays?: number;
	dailyCap?: number;
	expiresAt?: number;
	/**
	 * Also write each accepted event into `drops`. Off by default and nothing
	 * depends on it (§14 decision 2) -- the queue verbs are the real consumption
	 * path, with crash semantics a `drops` row does not have.
	 */
	mirrorToDrops?: boolean;
}

export function view(env: Env, row: WebhookReceiver) {
	const { auth_config, handshake_config, extract_config, ...rest } = row;
	let extract: unknown = null;
	try {
		extract = extract_config ? JSON.parse(extract_config) : null;
	} catch {
		extract = extract_config;
	}
	return {
		...rest,
		url: hookUrl(env, row.inbox, row.slug),
		extract_config: extract,
		secret_set: Boolean(auth_config),
		handshake_secret_set: Boolean(handshake_config),
	};
}

export function normalizeMethods(raw: string | undefined): string {
	const methods = (raw || "POST")
		.split(",")
		.map((m) => m.trim().toUpperCase())
		.filter(Boolean);
	return methods.length ? [...new Set(methods)].join(",") : "POST";
}

/**
 * The slug a create request asks for. `slug` is used verbatim; anything else
 * gets an unguessable suffix, because for a receiver without a signature the URL
 * IS the credential and a clean guessable slug hands it away.
 */
export function slugFor(body: CreateBody): string | null {
	if (body.slug) return normalizeSlug(body.slug);
	const base = normalizeSlug(body.name || body.label || "hook") || "hook";
	return `${base}-${slugSuffix()}`;
}

/** Refuse a mode nothing implements rather than silently not checking it. */
export function unsupportedMode(body: {
	authMode?: string;
	handshakeMode?: string;
	preset?: string;
}): string | null {
	const auth = body.authMode || "none";
	if (!SUPPORTED_AUTH_MODES.includes(auth)) {
		return `auth_mode '${auth}' is not implemented yet (have: ${SUPPORTED_AUTH_MODES.join(", ")})`;
	}
	const handshake = body.handshakeMode || "none";
	if (!SUPPORTED_HANDSHAKE_MODES.includes(handshake)) {
		return `handshake_mode '${handshake}' is not implemented yet (have: ${SUPPORTED_HANDSHAKE_MODES.join(", ")})`;
	}
	if (body.preset && !isKnownPreset(body.preset)) {
		return `unknown preset '${body.preset}' (have: ${presetNames().join(", ")})`;
	}
	return null;
}

/**
 * A handshake mode that cannot answer is refused at registration.
 *
 * The alternative is a receiver that looks configured, gets pasted into a
 * provider's dashboard, and fails its validation with an error only our logs
 * carry -- days later for Zoom, which re-runs its check every 72 hours. Same
 * fail-closed posture as the mode gate above: the two halves of a promise that
 * cannot be kept are refused together.
 */
export function handshakeConfigError(mode: string, config: unknown): string | null {
	const cfg = (config ?? {}) as HandshakeConfig;
	if (mode === "meta" && !(cfg.token || cfg.secret)) {
		return "handshake_mode 'meta' needs a verify token -- the string you typed into the provider's dashboard";
	}
	if (mode === "zoom" && !(cfg.secret || cfg.token)) {
		return "handshake_mode 'zoom' needs the webhook secret token -- its CRC answer is an HMAC keyed by it";
	}
	if (mode === "static" && !Object.keys(cfg.when ?? {}).length) {
		return "handshake_mode 'static' needs a `when` predicate -- an empty one matches nothing, on purpose";
	}
	return null;
}

/**
 * Meta's verification request is a GET, so a POST-only receiver 405s before the
 * handshake ever runs -- and the operator sees "verification failed" with no clue
 * that a method list is the reason. Widening it is one line here versus a bad
 * afternoon there.
 */
export function methodsForHandshake(methods: string, mode: string | undefined): string {
	if (mode !== "meta") return methods;
	const list = methods.split(",");
	return list.includes("GET") ? methods : [...list, "GET"].join(",");
}

/** Body field -> column, for the fields a PATCH may set directly. */
const PATCHABLE: Record<string, string> = {
	label: "label",
	enabled: "enabled",
	preset: "preset",
	responseStatus: "response_status",
	responseBody: "response_body",
	responseContentType: "response_content_type",
	methods: "allowed_methods",
	maxBodyBytes: "max_body_bytes",
	retentionDays: "retention_days",
	dailyCap: "daily_cap",
	expiresAt: "expires_at",
	mirrorToDrops: "mirror_to_drops",
};

export interface PatchPlan {
	sets: string[];
	params: (string | number | null)[];
}

/**
 * Turn a PATCH body into a SET clause. Returns an error string for a mode this
 * build cannot honour, so an operator cannot flip a live receiver into believing
 * it is verified when nothing verifies it.
 */
export function planPatch(body: Record<string, unknown>): PatchPlan | string {
	const sets: string[] = [];
	const params: (string | number | null)[] = [];

	for (const [key, column] of Object.entries(PATCHABLE)) {
		if (body[key] === undefined) continue;
		let value = body[key];
		if (typeof value === "boolean") value = value ? 1 : 0;
		if (key === "methods") value = normalizeMethods(String(value));
		sets.push(`${column} = ?`);
		params.push(value as string | number | null);
	}

	// A config blob is replaced wholesale, which is what rotation is: the old
	// secret stops working the moment the new one lands.
	for (const [key, column] of [
		["authConfig", "auth_config"],
		["handshakeConfig", "handshake_config"],
		["extract", "extract_config"],
	] as const) {
		if (body[key] === undefined) continue;
		sets.push(`${column} = ?`);
		params.push(body[key] ? JSON.stringify(body[key]) : null);
	}

	if (body.authMode !== undefined) {
		const denied = unsupportedMode({ authMode: String(body.authMode) });
		if (denied) return denied;
		sets.push("auth_mode = ?");
		params.push(String(body.authMode));
	}
	if (body.handshakeMode !== undefined) {
		const denied = unsupportedMode({ handshakeMode: String(body.handshakeMode) });
		if (denied) return denied;
		sets.push("handshake_mode = ?");
		params.push(String(body.handshakeMode));
	}

	return { sets, params };
}
