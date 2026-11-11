export type CappedBodyRead =
	| { ok: true; bytes: Uint8Array }
	| { ok: false; reason: "too-large" | "unreadable" };

/** Read a byte stream without ever retaining more than `maxBytes`. */
export async function readBodyCapped(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number,
): Promise<CappedBodyRead> {
	if (!body) return { ok: true, bytes: new Uint8Array() };

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value?.byteLength) continue;

			if (total + value.byteLength > maxBytes) {
				await reader.cancel("body too large").catch(() => {});
				return { ok: false, reason: "too-large" };
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} catch {
		await reader.cancel("body unreadable").catch(() => {});
		return { ok: false, reason: "unreadable" };
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { ok: true, bytes };
}

/**
 * Read a request body under a byte budget, answering the client on failure.
 * A declared Content-Length over the cap is refused before a byte is read; a
 * chunked body is cut off the moment it crosses the cap. `what` names the body
 * in the error ("multipart request body is too large").
 */
export async function readRequestCapped(
	request: Request,
	maxBytes: number,
	what: string,
): Promise<Uint8Array | Response> {
	const declaredHeader = request.headers.get("content-length");
	const declared = declaredHeader === null ? Number.NaN : Number(declaredHeader);
	if (Number.isFinite(declared) && declared > maxBytes) {
		return Response.json({ error: `${what} is too large` }, { status: 413 });
	}
	const read = await readBodyCapped(request.body, maxBytes);
	if (read.ok) return read.bytes;
	return read.reason === "too-large"
		? Response.json({ error: `${what} is too large` }, { status: 413 })
		: Response.json({ error: `could not read ${what}` }, { status: 400 });
}

/** Parse bytes as a JSON object. Anything else -- malformed, array, null -- is null. */
export function parseJsonObject(bytes: Uint8Array): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}
