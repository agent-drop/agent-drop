import { describe, expect, test } from "bun:test";
import { readBodyCapped } from "../src/lib/body-limit";

const encode = (value: string) => new TextEncoder().encode(value);

describe("readBodyCapped", () => {
	test("keeps byte-identical chunks at exactly the limit", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encode("hello"));
				controller.enqueue(encode("world"));
				controller.close();
			},
		});

		const result = await readBodyCapped(stream, 10);

		expect(result.ok).toBe(true);
		if (result.ok) expect(new TextDecoder().decode(result.bytes)).toBe("helloworld");
	});

	test("cancels as soon as the next chunk crosses the limit", async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encode("eleven bytes"));
			},
			cancel() {
				cancelled = true;
			},
		});

		expect(await readBodyCapped(stream, 10)).toEqual({ ok: false, reason: "too-large" });
		expect(cancelled).toBe(true);
	});

	test("reports a stream error as unreadable", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(new Error("broken stream"));
			},
		});

		expect(await readBodyCapped(stream, 10)).toEqual({ ok: false, reason: "unreadable" });
	});
});
