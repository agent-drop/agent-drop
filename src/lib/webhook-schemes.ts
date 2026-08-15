/**
 * What each provider calls its signature, and what it signs.
 *
 * Every row of section 5's table resolves to the same small shape -- a header, a
 * list of candidate signatures out of it, an optional timestamp, and the template
 * of the string that was signed -- so the verifier itself has one code path and
 * this file holds all the provider trivia.
 */

import {
	decodeBase64,
	isAlgorithm,
	type SigAlgorithm,
	type SigEncoding,
	utf8,
} from "./webhook-crypto";

/** The receiver's `auth_config` JSON blob. Every field is optional by mode. */
export interface AuthConfig {
	secret?: string;
	/** `hmac`/`digest`/`header`: the header carrying the signature or token. */
	header?: string;
	/** `query`: the query parameter carrying the token. Defaults to `token`. */
	param?: string;
	/** `hmac`/`digest`: what gets signed. Placeholders are spliced as bytes. */
	template?: string;
	encoding?: SigEncoding;
	algorithm?: string;
	/** A literal prefix to strip off the header value before comparing. */
	prefix?: string;
	/** Replay tolerance. null or absent = the scheme's default; 0 = no window. */
	toleranceSeconds?: number | null;
	timestampHeader?: string;
	idHeader?: string;
	/** `basic`: compared against the decoded credential. */
	username?: string;
	password?: string;
	/** `header`/`query`/`bearer`: the expected value, if not given as `secret`. */
	value?: string;
}

export interface SignedScheme {
	header: string;
	signatures: string[];
	timestamp: string | null;
	id: string | null;
	/** null = this scheme has no replay window. */
	toleranceSeconds: number | null;
	template: string;
	encoding: SigEncoding;
	algorithm: SigAlgorithm;
	/** A plain hash over the template rather than an HMAC (the `digest` family). */
	plain: boolean;
	key: Uint8Array;
	secret: string;
}

const FIVE_MINUTES = 300;

/** `t=1786771000,v1=abc,v1=def` -> every value for a given key, in order. */
function pairs(value: string): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const part of value.split(",")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		const key = part.slice(0, eq).trim();
		const list = out.get(key) ?? [];
		list.push(part.slice(eq + 1).trim());
		out.set(key, list);
	}
	return out;
}

/** Strip a `sha256=`-style algorithm tag, plus whatever the receiver configured. */
function stripPrefix(value: string, configured?: string): string {
	let out = value.trim();
	if (configured && out.startsWith(configured)) out = out.slice(configured.length);
	return out.replace(/^(sha1|sha256|sha512)=/i, "");
}

/**
 * Standard Webhooks secrets are base64, conventionally behind a `whsec_` tag. A
 * secret that cannot be base64 is used as its own raw bytes rather than failing
 * outright -- that only happens when base64 was never plausible, so it cannot be
 * confused for the decoded form.
 */
function standardKey(secret: string): Uint8Array {
	const bare = secret.replace(/^whsec_/, "");
	return decodeBase64(bare) ?? utf8(bare);
}

type Builder = (headers: Headers, cfg: AuthConfig) => SignedScheme | string;

function need(headers: Headers, name: string): string | null {
	return headers.get(name);
}

export const SCHEMES: Record<string, Builder> = {
	standard(headers, cfg) {
		// A space-separated list: `v1,<sig> v1,<sig>` during a rotation.
		const raw = need(headers, "webhook-signature");
		if (!raw) return "no webhook-signature header";
		const signatures = raw
			.split(/\s+/)
			.filter(Boolean)
			.filter((entry) => entry.startsWith("v1,"))
			.map((entry) => entry.slice(3));
		return {
			header: "webhook-signature",
			signatures,
			timestamp: need(headers, "webhook-timestamp"),
			id: need(headers, "webhook-id"),
			toleranceSeconds: cfg.toleranceSeconds ?? FIVE_MINUTES,
			template: "{id}.{ts}.{body}",
			encoding: "base64",
			algorithm: "sha256",
			plain: false,
			key: standardKey(cfg.secret ?? ""),
			secret: cfg.secret ?? "",
		};
	},

	github(headers, cfg) {
		const raw = need(headers, "x-hub-signature-256");
		if (!raw) return "no x-hub-signature-256 header";
		return {
			header: "x-hub-signature-256",
			signatures: raw.split(",").map((entry) => stripPrefix(entry)),
			timestamp: null,
			id: need(headers, "x-github-delivery"),
			toleranceSeconds: cfg.toleranceSeconds ?? null,
			template: "{body}",
			encoding: "hex",
			algorithm: "sha256",
			plain: false,
			key: utf8(cfg.secret ?? ""),
			secret: cfg.secret ?? "",
		};
	},

	stripe(headers, cfg) {
		const raw = need(headers, "stripe-signature");
		if (!raw) return "no stripe-signature header";
		const parsed = pairs(raw);
		return {
			header: "stripe-signature",
			// Several v1 entries mean a rotation is in flight; any of them may match.
			signatures: parsed.get("v1") ?? [],
			timestamp: parsed.get("t")?.[0] ?? null,
			id: null,
			toleranceSeconds: cfg.toleranceSeconds ?? FIVE_MINUTES,
			template: "{ts}.{body}",
			encoding: "hex",
			algorithm: "sha256",
			plain: false,
			key: utf8(cfg.secret ?? ""),
			secret: cfg.secret ?? "",
		};
	},

	slack(headers, cfg) {
		const raw = need(headers, "x-slack-signature");
		if (!raw) return "no x-slack-signature header";
		return {
			header: "x-slack-signature",
			signatures: raw.split(",").map((entry) => entry.trim().replace(/^v0=/i, "")),
			timestamp: need(headers, "x-slack-request-timestamp"),
			id: null,
			toleranceSeconds: cfg.toleranceSeconds ?? FIVE_MINUTES,
			template: "v0:{ts}:{body}",
			encoding: "hex",
			algorithm: "sha256",
			plain: false,
			key: utf8(cfg.secret ?? ""),
			secret: cfg.secret ?? "",
		};
	},

	shopify(headers, cfg) {
		const raw = need(headers, "x-shopify-hmac-sha256");
		if (!raw) return "no x-shopify-hmac-sha256 header";
		return {
			header: "x-shopify-hmac-sha256",
			signatures: [raw],
			timestamp: null,
			id: need(headers, "x-shopify-webhook-id"),
			toleranceSeconds: cfg.toleranceSeconds ?? null,
			template: "{body}",
			encoding: "base64",
			algorithm: "sha256",
			plain: false,
			key: utf8(cfg.secret ?? ""),
			secret: cfg.secret ?? "",
		};
	},

	hmac: (headers, cfg) => configured(headers, cfg, false),
	digest: (headers, cfg) => configured(headers, cfg, true),
};

/**
 * The two open-ended modes. `digest` defaults to 17TRACK's shape because a digest
 * with no secret in the template hashes nothing an attacker could not hash too --
 * so a secret-free template is refused outright rather than verifying nothing.
 */
function configured(headers: Headers, cfg: AuthConfig, plain: boolean): SignedScheme | string {
	const header = cfg.header?.toLowerCase();
	if (!header) return `auth_config.header is required for ${plain ? "digest" : "hmac"} mode`;

	const raw = need(headers, header);
	if (!raw) return `no ${header} header`;

	const template = cfg.template ?? (plain ? "{body}/{secret}" : "{body}");
	if (plain && !template.includes("{secret}")) {
		return "digest template must contain {secret} -- without it the hash proves nothing";
	}

	const algorithm = cfg.algorithm ?? "sha256";
	if (!isAlgorithm(algorithm)) return `unknown algorithm '${algorithm}'`;

	return {
		header,
		signatures: raw.split(",").map((entry) => stripPrefix(entry, cfg.prefix)),
		timestamp: cfg.timestampHeader ? need(headers, cfg.timestampHeader) : null,
		id: cfg.idHeader ? need(headers, cfg.idHeader) : null,
		toleranceSeconds: cfg.toleranceSeconds ?? null,
		template,
		encoding: cfg.encoding === "base64" ? "base64" : "hex",
		algorithm,
		plain,
		key: utf8(cfg.secret ?? ""),
		secret: cfg.secret ?? "",
	};
}
