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
