/**
 * Turning a STORED header map back into headers you can actually send.
 *
 * Two different things re-deliver a stored event -- `queue-replay`, which POSTs
 * from the CLI, and `payload_mode: passthrough`, which POSTs from the queue
 * consumer -- and they have to agree about what comes off, or the same event
 * arrives at two targets looking like two different requests. So the filter
 * lives here once and both import it.
 */

/** Everything the receiver redacted before storing. */
const REDACTED = "<redacted>";

/**
 * Headers that describe the connection they arrived on and nothing else. `host`
 * names the address the provider dialled, which is ours and not the target's;
 * `content-length` describes bytes we are about to re-count; the rest belong to
 * a TCP connection that closed a long time ago. Sending any of them re-labels
 * this request with facts from a dead one.
 */
const HOP_BY_HOP = new Set([
	"host",
	"content-length",
	"connection",
	"keep-alive",
	"transfer-encoding",
	"te",
	"trailer",
	"upgrade",
	"proxy-authenticate",
	"proxy-connection",
]);

/**
 * The subset of a stored header map that is safe and meaningful to re-send.
 *
 * A redacted credential is dropped rather than forwarded: the stored value is
 * the literal string `<redacted>`, and sending that is strictly worse than
 * sending nothing -- the target would see a header that looks present and is
 * guaranteed wrong. A signature header, by contrast, goes through untouched.
 * That is the whole reason it was stored verbatim: the target verifies it
 * against the bytes we are re-sending, and gets the same answer the provider
 * intended.
 */
export function replayableHeaders(stored: Record<string, unknown> | null): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(stored ?? {})) {
		if (value === REDACTED || value === null || value === undefined) continue;
		const key = name.toLowerCase();
		if (HOP_BY_HOP.has(key)) continue;
		out[key] = String(value);
	}
	return out;
}
