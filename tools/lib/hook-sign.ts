/**
 * Producing a signature the worker's verifier will accept.
 *
 * This is the other half of `src/lib/webhook-schemes.ts` -- that one reads a
 * provider's headers, this one writes them. The crypto itself is imported from
 * `src/lib/webhook-crypto.ts` rather than reimplemented, because two copies of a
 * hashing routine are two copies that eventually disagree, and the whole value of
 * `hook-test` is that a pass here means a real provider would also pass.
 *
 * What it deliberately does NOT do is prove the schemes are right -- the unit
 * tests do that, against the providers' own published vectors. This proves the
 * DEPLOYMENT: routing, the stored secret, the extraction config, the queue.
 */

import {
	buildSignedBytes,
	decodeBase64,
	digestBytes,
	hmacBytes,
	toBase64,
	toHex,
	utf8,
} from "../../src/lib/webhook-crypto";

export interface SignOptions {
	mode: string;
	secret: string;
	body: Uint8Array;
	/** Unix SECONDS. The schemes with a replay window sign this too. */
	timestamp: number;
	/** `hmac`/`digest`/`header`: which header carries the value. */
	header?: string;
	/** `hmac`/`digest`: what gets signed. */
	template?: string;
	/** `query`: which parameter carries the token. */
	param?: string;
	/** `standard`: the message id, which is part of the signed string. */
	id?: string;
}

export interface SignedRequest {
	headers: Record<string, string>;
	/** Query parameters to append -- only `query` mode uses this. */
	query: Record<string, string>;
}

const NOTHING: SignedRequest = { headers: {}, query: {} };

async function hmacOver(key: Uint8Array, template: string, opts: SignOptions): Promise<Uint8Array> {
	return hmacBytes(key, message(template, opts));
}

function message(template: string, opts: SignOptions): Uint8Array {
	return buildSignedBytes(template, {
		body: opts.body,
		ts: String(opts.timestamp),
		t: String(opts.timestamp),
		id: opts.id ?? "",
		secret: opts.secret,
	});
}

export async function signRequest(opts: SignOptions): Promise<SignedRequest> {
	const ts = String(opts.timestamp);
	const key = utf8(opts.secret);

	switch (opts.mode) {
		case "none":
			return NOTHING;

		case "github":
			return {
				headers: {
					"X-Hub-Signature-256": `sha256=${toHex(await hmacOver(key, "{body}", opts))}`,
				},
				query: {},
			};

		case "standard": {
			// The secret is base64 behind a `whsec_` tag, per the spec.
			const bare = opts.secret.replace(/^whsec_/, "");
			const raw = decodeBase64(bare) ?? utf8(bare);
			const id = opts.id ?? "msg_hooktest";
			const signature = await hmacBytes(raw, message("{id}.{ts}.{body}", { ...opts, id }));
			return {
				headers: {
					"webhook-id": id,
					"webhook-timestamp": ts,
					"webhook-signature": `v1,${toBase64(signature)}`,
				},
				query: {},
			};
		}

		case "stripe":
			return {
				headers: {
					"Stripe-Signature": `t=${ts},v1=${toHex(await hmacOver(key, "{ts}.{body}", opts))}`,
				},
				query: {},
			};

		case "slack":
			return {
				headers: {
					"X-Slack-Request-Timestamp": ts,
					"X-Slack-Signature": `v0=${toHex(await hmacOver(key, "v0:{ts}:{body}", opts))}`,
				},
				query: {},
			};

		case "shopify":
			return {
				headers: {
					"X-Shopify-Hmac-Sha256": toBase64(await hmacOver(key, "{body}", opts)),
				},
				query: {},
			};

		case "hmac": {
			const header = requireHeader(opts, "hmac");
			const signature = await hmacOver(key, opts.template ?? "{body}", opts);
			return { headers: { [header]: toHex(signature) }, query: {} };
		}

		case "digest": {
			// 17TRACK's family: a plain SHA-256 over the template, not an HMAC. The
			// secret is IN the signed string rather than being key material.
			const header = opts.header ?? "sign";
			const template = opts.template ?? "{body}/{secret}";
			return {
				headers: { [header]: toHex(await digestBytes(message(template, opts))) },
				query: {},
			};
		}

		case "bearer":
			return { headers: { Authorization: `Bearer ${opts.secret}` }, query: {} };

		case "basic":
			return { headers: { Authorization: `Basic ${toBase64(utf8(opts.secret))}` }, query: {} };

		case "header":
			return { headers: { [requireHeader(opts, "header")]: opts.secret }, query: {} };

		case "query":
			return { headers: {}, query: { [opts.param ?? "token"]: opts.secret } };

		default:
			throw new Error(`hook-test cannot sign for auth mode '${opts.mode}'`);
	}
}

function requireHeader(opts: SignOptions, mode: string): string {
	if (!opts.header) {
		throw new Error(
			`--header is required for ${mode} mode (the API never returns auth_config, so the CLI cannot look it up)`,
		);
	}
	return opts.header;
}
