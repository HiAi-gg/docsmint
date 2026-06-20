import { describe, expect, test } from "bun:test";

describe("embedding providers", () => {
	test("getEmbedding returns 1024-dim vector (fallback to zero when unavailable)", async () => {
		const mod = await import("../embedding/index");
		const result = await mod.getEmbedding("test text");
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBe(1024);
	});

	test("embedDocument returns array of 1024-dim vectors", async () => {
		const mod = await import("../embedding/index");
		const result = await mod.embedDocument(
			"Test Title",
			"Short content for test.",
		);
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBeGreaterThanOrEqual(1);
		if (result[0]) {
			expect(result[0].length).toBe(1024);
		}
	});

	test("normalizeDimensions utility works correctly", async () => {
		const mod = await import("../embedding/utils");
		// Test with vector shorter than target
		const short = mod.normalizeDimensions([1, 2, 3], 5);
		expect(short).toEqual([1, 2, 3, 0, 0]);

		// Test with vector longer than target
		const long = mod.normalizeDimensions([1, 2, 3, 4, 5], 3);
		expect(long).toEqual([1, 2, 3]);

		// Test with exact length
		const exact = mod.normalizeDimensions([1, 2, 3], 3);
		expect(exact).toEqual([1, 2, 3]);
	});
});
