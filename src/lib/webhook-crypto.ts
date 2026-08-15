/**
 * The byte-level primitives every webhook signature scheme shares.
 *
 * Two things here are the whole reason this file exists rather than a handful of
 * inline `crypto.subtle` calls.
 *
 * The signed message is assembled as BYTES, with the request body spliced in
 * untouched. Building it as a string first would force the body through a UTF-8
 * round trip, and a body that was never valid UTF-8 would be mangled before it
 * was ever hashed -- the exact failure the receive path reads `arrayBuffer()` to
 * avoid.
 *
 * And a candidate signature is compared with no assumption about its length or
 * its case. 17TRACK's own Java sample is `new BigInteger(1, hash).toString(16)`
 * zero-padded to 64, and that padding loop is doing real work: `BigInteger` drops
 * leading zeros, so roughly one signature in 256 arrives 63 characters long. A
 * verifier that assumes 64 rejects those, once in every few hundred deliveries,
 * for no reason anybody will find quickly.
 */

import { constantTimeEqual } from "./compare";

export type SigEncoding = "hex" | "base64";
export type SigAlgorithm = "sha1" | "sha256" | "sha512";

const SUBTLE_HASH: Record<SigAlgorithm, string> = {
	sha1: "SHA-1",
	sha256: "SHA-256",
	sha512: "SHA-512",
};

const encoder = new TextEncoder();

/**
 * What `crypto.subtle` will take, named structurally rather than as `BufferSource`.
 *
 * TypeScript 5.7 narrowed `BufferSource` to ArrayBuffer-backed views, so a plain
 * `Uint8Array` -- which the type system must assume could be SharedArrayBuffer-
 * backed -- no longer satisfies it, and the calls below need a cast. The runtime
 * draws no such distinction and nothing here ever sees a SharedArrayBuffer.
 *
 * Deriving the type from the function rather than writing `BufferSource` is what
 * lets the CLI import this file: `tools/tsconfig.json` loads no DOM lib, so the
 * NAME is not in scope there even though the parameter type is.
 */
type SubtleData = Parameters<typeof crypto.subtle.digest>[1];

export function isAlgorithm(name: string): name is SigAlgorithm {
	return name in SUBTLE_HASH;
}

export function utf8(text: string): Uint8Array {
	return encoder.encode(text);
}

export async function hmacBytes(
	key: Uint8Array,
	message: Uint8Array,
	algorithm: SigAlgorithm = "sha256",
): Promise<Uint8Array> {
	const imported = await crypto.subtle.importKey(
		"raw",
		key as SubtleData,
		{ name: "HMAC", hash: SUBTLE_HASH[algorithm] },
		false,
		["sign"],
	);
	return new Uint8Array(await crypto.subtle.sign("HMAC", imported, message as SubtleData));
}

/**
 * A plain hash of the message, NOT an HMAC. A real family of providers -- 17TRACK
 * among them -- concatenates the secret into the signed string and takes a bare
 * SHA-256. It is weaker than HMAC, but refusing to support it just means those
 * providers cannot be verified at all.
 */
export async function digestBytes(
	message: Uint8Array,
	algorithm: SigAlgorithm = "sha256",
): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest(SUBTLE_HASH[algorithm], message as SubtleData));
}

export function toHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** Returns null for anything that is not decodable, rather than throwing. */
export function decodeBase64(text: string): Uint8Array | null {
	try {
		const binary = atob(text);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
		return out;
	} catch {
		return null;
	}
}

/**
 * Assemble the signed message, splicing raw byte parts in unmodified.
 *
 * An unknown placeholder is left standing as literal text rather than quietly
 * becoming empty: a typo in a receiver's template must not silently change what
 * gets signed and then fail every delivery with a signature mismatch.
 */
export function buildSignedBytes(
	template: string,
	parts: Record<string, Uint8Array | string>,
): Uint8Array {
	const chunks: Uint8Array[] = [];
	let cursor = 0;

	for (const match of template.matchAll(/\{(\w+)\}/g)) {
		const at = match.index ?? 0;
		if (at > cursor) chunks.push(utf8(template.slice(cursor, at)));
		const part = parts[match[1]];
		if (part === undefined) chunks.push(utf8(match[0]));
		else chunks.push(typeof part === "string" ? utf8(part) : part);
		cursor = at + match[0].length;
	}
	if (cursor < template.length) chunks.push(utf8(template.slice(cursor)));

	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/**
 * Does any candidate match the expected digest?
 *
 * A list rather than a single value because `standard` and `stripe` both send
 * SEVERAL signatures during a secret rotation, and a verifier that only reads the
 * first one breaks every rotation it ever sees.
 *
 * Every candidate is compared even after one matches, so how long this takes does
 * not depend on WHICH one matched.
 */
export function matchesAny(
	expected: Uint8Array,
	candidates: string[],
	encoding: SigEncoding,
): boolean {
	const want = encoding === "hex" ? toHex(expected) : stripPadding(toBase64(expected));
	let matched = false;
	for (const candidate of candidates) {
		if (constantTimeEqual(normalizeSignature(candidate, encoding, want.length), want)) {
			matched = true;
		}
	}
	return matched;
}

function stripPadding(text: string): string {
	return text.replace(/=+$/, "");
}

/**
 * Hex is lowercased and left-zero-padded up to the expected width (see the
 * BigInteger note at the top); base64 has its padding stripped from both sides,
 * because some providers send it unpadded. Neither normalization can turn a wrong
 * signature into a right one -- padding only ever adds leading zeros that a
 * correct digest must have had anyway.
 */
function normalizeSignature(raw: string, encoding: SigEncoding, width: number): string {
	const trimmed = raw.trim();
	if (encoding === "base64") return stripPadding(trimmed);
	const lower = trimmed.toLowerCase();
	return lower.length < width ? lower.padStart(width, "0") : lower;
}
