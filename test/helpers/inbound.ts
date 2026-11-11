/**
 * An inbound ForwardableEmailMessage for handleEmail, with a recorded setReject.
 *
 * `from` is the envelope sender; `fromHeader` is the From header the sender's
 * client wrote, which is where a display name lives. They differ in real mail
 * (an ESP's envelope is a bounce address). A `null` fromHeader omits the header;
 * `extraHeaders` are written verbatim.
 */
export interface IncomingEmail {
	message: ForwardableEmailMessage;
	rejection(): string | null;
}

export function incoming(
	from: string,
	to: string,
	subject = "Hello",
	fromHeader: string | null = from,
	extraHeaders: string[] = [],
): IncomingEmail {
	const raw = [
		...(fromHeader === null ? [] : [`From: ${fromHeader}`]),
		...extraHeaders,
		`To: ${to}`,
		`Subject: ${subject}`,
		"Message-ID: <incoming@example.test>",
		"Content-Type: text/plain; charset=UTF-8",
		"",
		"Body text",
	].join("\r\n");
	let rejected: string | null = null;
	return {
		message: {
			from,
			to,
			headers: new Headers({
				subject,
				"message-id": "<incoming@example.test>",
				"in-reply-to": "<previous@example.test>",
				references: "<root@example.test>",
			}),
			raw: new Response(raw).body as ReadableStream<Uint8Array>,
			rawSize: new TextEncoder().encode(raw).byteLength,
			canBeForwarded: true,
			setReject(reason: string) {
				rejected = reason;
			},
			forward: async () => ({ messageId: "unused" }),
			reply: async () => ({ messageId: "unused" }),
		} as ForwardableEmailMessage,
		rejection: () => rejected,
	};
}
