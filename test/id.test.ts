import { describe, expect, test } from "bun:test";
import { generateId } from "../src/lib/id";

// Layout: 26 chars total -- 10 chars of base32 timestamp, then 16 chars of randomness.
const TS_LEN = 10;
const RAND_LEN = 16;
const ENCODING = "0123456789abcdefghjkmnpqrstvwxyz";

describe("generateId", () => {
	test("is 26 chars of Crockford-ish base32", () => {
		for (let i = 0; i < 100; i++) {
			const id = generateId();
			expect(id).toHaveLength(TS_LEN + RAND_LEN);
			for (const ch of id) expect(ENCODING).toContain(ch);
		}
	});

	test("random tail is not a repeating window", () => {
		// REGRESSION: the random tail used to be drawn from a 10-byte pool indexed
		// by `rand[i % 10]`, so tail chars 10..15 were byte-for-byte copies of
		// tail chars 0..5 in *every* id -- 6 of 16 chars carried zero entropy.
		const SAMPLES = 200;
		let repeats = 0;
		for (let i = 0; i < SAMPLES; i++) {
			const tail = generateId().slice(TS_LEN);
			if (tail.slice(10, 16) === tail.slice(0, 6)) repeats++;
		}
		// By chance this collides at ~32^-6; anything above a couple of hits means
		// the tail is structurally correlated rather than random.
		expect(repeats).toBeLessThan(3);
	});

	test("every random position varies across samples", () => {
		const SAMPLES = 500;
		const seen: Set<string>[] = Array.from({ length: RAND_LEN }, () => new Set<string>());
		for (let i = 0; i < SAMPLES; i++) {
			const tail = generateId().slice(TS_LEN);
			for (let p = 0; p < RAND_LEN; p++) seen[p].add(tail[p]);
		}
		// 500 draws over a 32-symbol alphabet should hit most symbols at every position.
		for (let p = 0; p < RAND_LEN; p++) {
			expect(seen[p].size).toBeGreaterThan(20);
		}
	});

	test("ids are unique and lexicographically sortable by time", async () => {
		const ids = new Set<string>();
		for (let i = 0; i < 2000; i++) ids.add(generateId());
		expect(ids.size).toBe(2000);

		const first = generateId();
		await Bun.sleep(5);
		const later = generateId();
		expect(later.slice(0, TS_LEN) > first.slice(0, TS_LEN)).toBe(true);
	});
});
