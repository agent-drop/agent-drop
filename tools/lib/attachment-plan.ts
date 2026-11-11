/**
 * How `send-email` moves each local attachment: inline as base64 inside the
 * JSON request, or uploaded to R2 first and referenced by key.
 *
 * Inline is cheaper per file (no presign, no PUT), but it rides in a request
 * the worker caps at 8 MiB, and base64 inflates every byte by 4/3. A fixed
 * per-file threshold cannot respect a per-REQUEST cap: seven 1 MB files are a
 * ~9.3 MB body. So the decision is a running budget over the whole request,
 * and it lives here, pure, so it can be tested against the real handlers.
 */

// The worker's own limits, imported from the one module both sides share.
import {
	MAX_ATTACHMENT_TOTAL_BYTES,
	MAX_ATTACHMENTS,
	MAX_EMAIL_REQUEST_BYTES,
	MAX_INLINE_ATTACHMENT_BYTES,
} from "../../src/lib/send-limits";

export {
	MAX_ATTACHMENT_TOTAL_BYTES,
	MAX_ATTACHMENTS,
	MAX_EMAIL_REQUEST_BYTES,
	MAX_INLINE_ATTACHMENT_BYTES,
};

/** Above this a local file always goes through R2, whatever the budget says. */
export const INLINE_FILE_MAX_BYTES = 1_000_000;

/**
 * How large the CLI lets one JSON request grow: 1 MiB under the server's cap.
 * The estimate below is exact for everything but the R2 keys, so the headroom
 * only has to absorb a file growing between stat() and read(). Too much costs
 * one extra presign round trip; too little costs a failed send.
 */
export const REQUEST_BUDGET_BYTES = MAX_EMAIL_REQUEST_BYTES - 1024 * 1024;

/**
 * What a local file's entry gains on top of the skeleton the caller measured:
 * `"dataBase64":""` around the base64, or `"r2Key":"outbound/temp/{box}/{id}/{name}"`.
 * A 64-char box, a 26-char id and a 255-char name come to ~370 bytes.
 */
export const ENTRY_TRANSPORT_ALLOWANCE = 512;

export type Transport = "inline" | "upload";

export interface TransportPlan {
	/** One per local file, in the caller's order. */
	transports: Transport[];
	/** Upper-bound estimate of the JSON request under this plan, in bytes. */
	requestBytes: number;
}

/** Exact length of base64 for `bytes` input bytes, padding included. */
export function base64Length(bytes: number): number {
	return 4 * Math.ceil(bytes / 3);
}

/** UTF-8 bytes of `value` as JSON.stringify puts it on the wire. */
export function jsonByteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Decide inline vs upload for each local file.
 *
 * `baseBytes` is the JSON size of everything else in the request: recipients,
 * subject, the text/html/markdown body, and every attachment entry WITHOUT its
 * `dataBase64` / `r2Key` (URL attachments complete). The body rides in the same
 * request as the base64, so it spends the same budget.
 *
 * Smallest files go inline first. That inlines as many files as the budget
 * holds, and since base64 cost only grows with size, the first file that does
 * not fit means no later one does either -- it and everything after it upload.
 * The plan is per index, so the email keeps the attachment order the user gave.
 */
export function planAttachmentTransport(
	sizes: readonly number[],
	opts: { baseBytes: number; forceUpload?: boolean; budget?: number },
): TransportPlan {
	const budget = opts.budget ?? REQUEST_BUDGET_BYTES;
	const transports: Transport[] = sizes.map(() => "upload");
	let requestBytes = opts.baseBytes + sizes.length * ENTRY_TRANSPORT_ALLOWANCE;
	if (opts.forceUpload) return { transports, requestBytes };

	const candidates = sizes
		.map((size, index) => ({ size, index }))
		.filter((c) => c.size <= INLINE_FILE_MAX_BYTES)
		.sort((a, b) => a.size - b.size || a.index - b.index);

	for (const { size, index } of candidates) {
		const cost = base64Length(size);
		if (requestBytes + cost > budget) break;
		transports[index] = "inline";
		requestBytes += cost;
	}
	return { transports, requestBytes };
}

function mib(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * The server limits a send can be refused on, checked BEFORE any upload, so a
 * doomed send fails here instead of 413ing after it already PUT files to R2.
 * Returns the reason, or null if the send may go ahead.
 */
export function attachmentLimitError(input: {
	/** Every attachment, URLs included: the server counts them all. */
	count: number;
	/** Decoded bytes of the local files, inline and uploaded alike. */
	localBytes: number;
	/** `TransportPlan.requestBytes`. */
	requestBytes: number;
}): string | null {
	if (input.count > MAX_ATTACHMENTS) {
		return `too many attachments: ${input.count} (the server accepts at most ${MAX_ATTACHMENTS})`;
	}
	if (input.localBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
		return (
			`attachments total ${mib(input.localBytes)}; the server accepts at most ` +
			`${mib(MAX_ATTACHMENT_TOTAL_BYTES)} per message, decoded, URL attachments included`
		);
	}
	// Inline files are only ever planned within the budget, so a request over the
	// cap is one whose body, recipients and attachment names alone are too big.
	if (input.requestBytes > MAX_EMAIL_REQUEST_BYTES) {
		return (
			`message too large: ~${mib(input.requestBytes)} of JSON before any attachment data ` +
			`(body, recipients, attachment names); the server accepts at most ` +
			`${mib(MAX_EMAIL_REQUEST_BYTES)} per request`
		);
	}
	return null;
}
