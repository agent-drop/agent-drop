/**
 * Construction and validation for `EmailMessageBuilder`, the structured payload
 * `env.EMAIL.send()` accepts instead of hand-assembled MIME.
 *
 * Everything here is pure: it turns our own loosely-typed inputs (address
 * strings that may carry display names, attachments resolved to bytes) into the
 * shapes the binding demands, and rejects the payloads the platform would
 * reject anyway -- with a message that says which limit was hit, rather than an
 * opaque E_* code from the far side of the send.
 */

/** Combined to + cc + bcc accepted by the Email Sending binding. */
export const MAX_RECIPIENTS = 50;
/** Custom headers that are not X-prefixed. */
export const MAX_NON_X_HEADERS = 20;
/** Total custom-header payload, sum(name + 2 + value + 2). */
export const MAX_HEADER_BYTES = 16 * 1024;
/** Per-header limits the platform enforces. */
export const MAX_HEADER_NAME_BYTES = 100;
export const MAX_HEADER_VALUE_BYTES = 2048;

function hasHeaderControl(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

/** Reject bytes that can terminate or reshape an RFC header line. */
export function validateHeaderValue(label: string, value: string): string | null {
	return hasHeaderControl(value) ? `${label} contains a disallowed control character` : null;
}

/** The send API accepts one Message-ID token, not a header fragment or list. */
export function validateMessageId(value: string): string | null {
	const controlError = validateHeaderValue("inReplyTo", value);
	if (controlError) return controlError;
	return /^<[^<>\s@]+@[^<>\s@]+>$/.test(value)
		? null
		: "inReplyTo must be one Message-ID in <local@domain> form";
}

/** An attachment resolved to bytes, before it is shaped for the binding. */
export interface ResolvedAttachment {
	filename: string;
	contentType: string;
	content: string | ArrayBuffer | ArrayBufferView;
	inline?: boolean;
	cid?: string;
}

/**
 * Split `"Bob" <bob@x.com>` into the binding's address object. A bare address
 * stays a bare string -- `EmailAddress.name` is required, so inventing an empty
 * name would put a stray `"" <bob@x.com>` on the wire.
 */
export function parseAddress(input: string): string | EmailAddress {
	const trimmed = input.trim();
	const match = trimmed.match(/^(.*)<([^>]+)>$/);
	if (!match) return trimmed;

	const email = match[2].trim();
	const name = match[1]
		.trim()
		.replace(/^"(.*)"$/, "$1")
		.trim();
	return name ? { name, email } : email;
}

export function toRecipients(list: string[]): (string | EmailAddress)[] {
	return list.map(parseAddress);
}

/** The bare address, whichever shape it arrived in. */
export function addressOf(addr: string | EmailAddress): string {
	if (typeof addr !== "string") return addr.email;
	const match = addr.match(/<([^>]+)>/);
	return (match ? match[1] : addr).trim();
}

/**
 * Reject a recipient set the binding would reject. Returns a human-readable
 * reason, or null if the set is fine.
 */
export function validateRecipients(to: string[], cc: string[], bcc: string[]): string | null {
	const total = to.length + cc.length + bcc.length;
	if (total === 0) return "at least one recipient (to/cc/bcc) is required";
	if (total > MAX_RECIPIENTS) {
		return `too many recipients: ${total} (max ${MAX_RECIPIENTS} combined to/cc/bcc)`;
	}
	for (const [label, recipients] of [
		["to", to],
		["cc", cc],
		["bcc", bcc],
	] as const) {
		for (const recipient of recipients) {
			const error = validateHeaderValue(`${label} recipient`, recipient);
			if (error) return error;
		}
	}
	return null;
}

const utf8 = new TextEncoder();

/**
 * Reject a custom-header set the binding would reject. Only threading headers
 * and X-* are ever set by this codebase today, so this exists to keep a future
 * caller honest rather than to police the current one.
 */
export function validateHeaders(headers: Record<string, string>): string | null {
	const entries = Object.entries(headers);

	const nonX = entries.filter(([name]) => !/^x-/i.test(name));
	if (nonX.length > MAX_NON_X_HEADERS) {
		return `too many custom headers: ${nonX.length} non-X- headers (max ${MAX_NON_X_HEADERS})`;
	}

	let total = 0;
	for (const [name, value] of entries) {
		const nameControlError = validateHeaderValue("header name", name);
		if (nameControlError) return nameControlError;
		const valueControlError = validateHeaderValue(`header value for ${name}`, value);
		if (valueControlError) return valueControlError;
		const nameBytes = utf8.encode(name).length;
		const valueBytes = utf8.encode(value).length;
		if (nameBytes > MAX_HEADER_NAME_BYTES) {
			return `header name too long: ${name} (${nameBytes} bytes, max ${MAX_HEADER_NAME_BYTES})`;
		}
		if (valueBytes > MAX_HEADER_VALUE_BYTES) {
			return `header value too long: ${name} (${valueBytes} bytes, max ${MAX_HEADER_VALUE_BYTES})`;
		}
		total += nameBytes + 2 + valueBytes + 2;
	}
	if (total > MAX_HEADER_BYTES) {
		return `custom headers too large: ${total} bytes (max ${MAX_HEADER_BYTES})`;
	}
	return null;
}

/**
 * Shape a resolved attachment for the binding.
 *
 * `content` goes across as bytes: the binding treats a string as RAW content,
 * not base64, so handing it a base64 string would attach the base64 text.
 * An inline attachment MUST carry a contentId -- one without is indistinguishable
 * from a regular attachment on the wire, so it is sent as one.
 */
export function toEmailAttachment(a: ResolvedAttachment): EmailAttachment {
	const cid = a.cid ? bareContentId(a.cid) : "";
	if (a.inline && cid) {
		return {
			disposition: "inline",
			contentId: cid,
			filename: a.filename,
			type: a.contentType,
			content: a.content,
		};
	}
	return {
		disposition: "attachment",
		filename: a.filename,
		type: a.contentType,
		content: a.content,
	};
}

/**
 * Strip the angle brackets off a Content-ID. postal-mime hands back the RAW
 * header value ("<logo123>"), while both our MIME renderer and the binding want
 * the bare token -- wrapping an already-wrapped id yields "<<logo123>>", which
 * no client matches against `cid:logo123`.
 */
export function bareContentId(cid: string): string {
	return cid.replace(/^<|>$/g, "").trim();
}
