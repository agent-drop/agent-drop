import { describe, expect, test } from "bun:test";
import {
	MAX_MULTIPART_BYTES,
	MAX_MULTIPART_PART_BYTES,
	MAX_MULTIPART_PARTS,
	MIN_MULTIPART_PART_BYTES,
	planMultipart,
} from "../src/api/upload";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

// The part size R2 is told about is the one the client slices by, and R2 wants
// every part but the last to be exactly that size. So the plan has to cover the
// file, leave no empty trailing part, and stay inside R2's per-part ceiling.
describe("planMultipart", () => {
	const sizes = [
		1,
		MIN_MULTIPART_PART_BYTES - 1,
		MIN_MULTIPART_PART_BYTES,
		MIN_MULTIPART_PART_BYTES + 1,
		700 * MiB,
		MIN_MULTIPART_PART_BYTES * MAX_MULTIPART_PARTS,
		MIN_MULTIPART_PART_BYTES * MAX_MULTIPART_PARTS + 1,
		6 * GiB,
		100 * GiB + 7,
		MAX_MULTIPART_BYTES - 1,
		MAX_MULTIPART_BYTES,
	];

	for (const fileSize of sizes) {
		test(`covers ${fileSize} bytes in at most ${MAX_MULTIPART_PARTS} parts`, () => {
			const { partSize, partCount } = planMultipart(fileSize);
			expect(partCount).toBeGreaterThanOrEqual(1);
			expect(partCount).toBeLessThanOrEqual(MAX_MULTIPART_PARTS);
			expect(partSize * partCount).toBeGreaterThanOrEqual(fileSize);
			expect(partSize * (partCount - 1)).toBeLessThan(fileSize);
			expect(partSize).toBeGreaterThanOrEqual(MIN_MULTIPART_PART_BYTES);
			expect(partSize).toBeLessThanOrEqual(MAX_MULTIPART_PART_BYTES);
			expect(partSize % MiB).toBe(0);
		});
	}

	test("keeps 50 MiB parts while they fit in 100", () => {
		expect(planMultipart(700 * MiB)).toEqual({ partSize: 50 * MiB, partCount: 14 });
		expect(planMultipart(MIN_MULTIPART_PART_BYTES * MAX_MULTIPART_PARTS)).toEqual({
			partSize: 50 * MiB,
			partCount: 100,
		});
	});

	test("rounds a grown part up to a whole MiB", () => {
		// 6 GiB / 100 = 61.44 MiB -> 62 MiB, which needs 100 parts (99.1).
		expect(planMultipart(6 * GiB)).toEqual({ partSize: 62 * MiB, partCount: 100 });
	});

	test("the ceiling is exactly 100 parts of R2's 5 GiB maximum", () => {
		expect(MAX_MULTIPART_PART_BYTES).toBe(5 * GiB);
		expect(MAX_MULTIPART_BYTES).toBe(MAX_MULTIPART_PARTS * MAX_MULTIPART_PART_BYTES);
		expect(planMultipart(MAX_MULTIPART_BYTES)).toEqual({
			partSize: 5 * GiB,
			partCount: 100,
		});
	});
});
