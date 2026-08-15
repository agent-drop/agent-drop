/**
 * Pulling `event_type`, `routing_key` and `dedupe_key` out of a received request.
 *
 * All three are conveniences: they make a stored event findable without reading
 * every body. None of them is allowed to fail the receive -- an unparseable or
 * unrecognised body is a successful receive, so every extractor here returns
 * null rather than throwing. The receiver's job is to preserve, not to
 * understand.
 */

/** Per-receiver overrides, stored as JSON in `webhook_receivers.extract_config`. */
export interface ExtractConfig {
	eventTypePath?: string;
	eventTypeHeader?: string;
	routingKeyPath?: string;
	routingKeyHeader?: string;
	/** `header` and `path` read the provider's own id; `body-hash` is the fallback. */
	dedupe?: "none" | "header" | "path" | "body-hash";
	dedupeHeader?: string;
	dedupePath?: string;
	/** body-hash only. Must exceed the provider's retry spacing. Default 15 min. */
	dedupeWindowMs?: number;
}

export const DEFAULT_DEDUPE_WINDOW_MS = 15 * 60 * 1000;

/** What a preset knows about a provider before the operator configures anything. */
const PRESETS: Record<string, ExtractConfig> = {
	github: {
		eventTypeHeader: "x-github-event",
		dedupe: "header",
		dedupeHeader: "x-github-delivery",
	},
	stripe: { eventTypePath: "type", dedupe: "path", dedupePath: "id" },
	standard: { eventTypePath: "type", dedupe: "header", dedupeHeader: "webhook-id" },
	svix: { eventTypePath: "type", dedupe: "header", dedupeHeader: "webhook-id" },
	// Slack sends no message id, only a timestamp -- pairing it with the body hash
	// is what makes a retry recognisable.
	slack: {
		eventTypePath: "event.type",
		dedupe: "header",
		dedupeHeader: "x-slack-request-timestamp",
	},
	shopify: {
		eventTypeHeader: "x-shopify-topic",
		dedupe: "header",
		dedupeHeader: "x-shopify-webhook-id",
	},
	generic: {},
};

export function presetNames(): string[] {
	return Object.keys(PRESETS);
}

export function isKnownPreset(name: string): boolean {
	return name in PRESETS;
}

/**
 * A tiny dotted-path reader over an already-parsed body -- deliberately not a
 * JSONPath dependency. `data.tag`, `$.data.object.customer` and `items.0.id` all
 * work; anything else reads as null.
 */
export function readPath(value: unknown, path: string): string | null {
	let cursor: unknown = value;
	for (const segment of path.replace(/^\$\.?/, "").split(".")) {
		if (!segment) continue;
		if (cursor === null || typeof cursor !== "object") return null;
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	if (cursor === null || cursor === undefined) return null;
	if (typeof cursor === "object") return null;
	return String(cursor);
}

export interface Extracted {
	eventType: string | null;
	routingKey: string | null;
	/** Null means "do not dedupe this one" -- the unique index ignores NULLs. */
	dedupeKey: string | null;
	/**
	 * Other keys that mean "the same event" inside the window. Only body-hash
	 * dedupe produces these: its key carries a time bucket so the same bytes may
	 * legitimately store again later, and the bucket boundary would otherwise let
	 * a retry through purely because the clock rolled over.
	 */
	dedupeAlternates: string[];
	dedupeWindowMs: number | null;
}

export interface ExtractInput {
	preset: string | null;
	config: ExtractConfig | null;
	headers: Headers;
	/** The parsed body, or undefined when it was not JSON (or not parseable). */
	body: unknown;
	bodySha256: string;
	now: number;
}

/** Resolve the preset's defaults, then let the receiver's own config win. */
export function resolveExtractConfig(
	preset: string | null,
	config: ExtractConfig | null,
): ExtractConfig {
	return { ...(preset ? (PRESETS[preset] ?? {}) : {}), ...(config ?? {}) };
}

export function extractFields(input: ExtractInput): Extracted {
	const cfg = resolveExtractConfig(input.preset, input.config);

	const eventType =
		(cfg.eventTypeHeader ? input.headers.get(cfg.eventTypeHeader) : null) ??
		(cfg.eventTypePath ? readPath(input.body, cfg.eventTypePath) : null);

	const routingKey =
		(cfg.routingKeyHeader ? input.headers.get(cfg.routingKeyHeader) : null) ??
		(cfg.routingKeyPath ? readPath(input.body, cfg.routingKeyPath) : null);

	return {
		eventType,
		routingKey,
		...dedupeFor(cfg, input),
	};
}

function dedupeFor(
	cfg: ExtractConfig,
	input: ExtractInput,
): Pick<Extracted, "dedupeKey" | "dedupeAlternates" | "dedupeWindowMs"> {
	const none = { dedupeKey: null, dedupeAlternates: [], dedupeWindowMs: null };

	switch (cfg.dedupe) {
		case "header": {
			const id = cfg.dedupeHeader ? input.headers.get(cfg.dedupeHeader) : null;
			// A provider that promises an id and then omits it (a dashboard test ping,
			// usually) must still store -- so a missing id means "do not dedupe".
			return id ? { ...none, dedupeKey: id } : none;
		}
		case "path": {
			const id = cfg.dedupePath ? readPath(input.body, cfg.dedupePath) : null;
			return id ? { ...none, dedupeKey: id } : none;
		}
		case "body-hash": {
			// Two byte-identical bodies can be two real events, so this is scoped to a
			// window rather than being absolute: the key carries the window bucket, and
			// the previous bucket is offered as an alternate so a retry landing just
			// past a boundary is still recognised. Outside the window the same bytes
			// store again, which is correct. Consumers must still tolerate duplicates
			// -- this narrows the window, it does not close it.
			const windowMs = cfg.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
			const bucket = Math.floor(input.now / windowMs);
			return {
				dedupeKey: `${input.bodySha256}.${bucket}`,
				dedupeAlternates: [`${input.bodySha256}.${bucket - 1}`],
				dedupeWindowMs: windowMs,
			};
		}
		default:
			return none;
	}
}
