/**
 * A double for the `EMAIL` (Email Sending) binding.
 *
 * `SendEmail.send()` is overloaded: it takes either a legacy raw `EmailMessage`
 * or a structured `EmailMessageBuilder`. Both call shapes are live in this
 * codebase on purpose -- the compose/forward paths use the builder, the relay
 * queue consumer replays stored raw MIME -- so the double records which one it
 * was handed rather than flattening them together.
 */

/** A legacy `new EmailMessage(from, to, raw)` send. */
export interface RawSend {
	kind: "raw";
	from: string;
	to: string;
	raw: string;
}

/** A structured `EmailMessageBuilder` send. */
export interface BuilderSend {
	kind: "builder";
	builder: EmailMessageBuilder;
}

export type RecordedSend = RawSend | BuilderSend;

export interface FakeEmail {
	send(message: unknown): Promise<{ messageId: string }>;
	/** Every send, in call order. */
	sends: RecordedSend[];
	/** Just the builder payloads. */
	builders(): EmailMessageBuilder[];
	/** Just the raw MIME sends. */
	raws(): RawSend[];
}

interface FakeEmailOptions {
	/** Platform message id to return. Defaults to a fixed value. */
	messageId?: string;
	/** Throw instead of accepting the send (mirrors an E_* binding error). */
	fail?: Error;
}

/**
 * An `EmailMessage` instance carries `raw`; a builder payload never does. That
 * is the only reliable discriminator -- the virtual `cloudflare:email` module in
 * test/setup.ts is not the runtime class, so `instanceof` would be a lie.
 */
function isRawMessage(msg: unknown): msg is { from: string; to: string; raw: string } {
	return typeof msg === "object" && msg !== null && "raw" in msg;
}

export function makeEmail(options: FakeEmailOptions = {}): FakeEmail {
	const sends: RecordedSend[] = [];
	const messageId = options.messageId ?? "cf-msg-0001";

	return {
		sends,
		async send(message: unknown) {
			if (options.fail) throw options.fail;
			if (isRawMessage(message)) {
				sends.push({ kind: "raw", from: message.from, to: message.to, raw: String(message.raw) });
			} else {
				sends.push({ kind: "builder", builder: message as EmailMessageBuilder });
			}
			return { messageId };
		},
		builders() {
			return sends.filter((s): s is BuilderSend => s.kind === "builder").map((s) => s.builder);
		},
		raws() {
			return sends.filter((s): s is RawSend => s.kind === "raw");
		},
	};
}

/** The single builder payload sent, failing loudly if there was not exactly one. */
export function onlyBuilder(email: FakeEmail): EmailMessageBuilder {
	const builders = email.builders();
	if (builders.length !== 1) {
		throw new Error(`expected exactly 1 builder send, got ${builders.length}`);
	}
	return builders[0];
}
