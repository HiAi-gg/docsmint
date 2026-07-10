import { describe, expect, test } from "bun:test";

import {
	embeddingProfileId,
	validateEmbeddingVector,
} from "../embedding/validation";

describe("embedding validation", () => {
	test("accepts exactly 1024 finite non-zero values", () => {
		expect(validateEmbeddingVector(Array(1024).fill(0.01))).toEqual({
			ok: true,
			dimensions: 1024,
		});
	});

	test.each<[number[], "zero_vector" | "wrong_dimensions" | "non_finite"]>([
		[Array(1024).fill(0), "zero_vector"],
		[Array(1023).fill(0.01), "wrong_dimensions"],
		[[...Array(1023).fill(0.01), Number.NaN], "non_finite"],
	])("rejects invalid vectors", (vector, code) => {
		expect(validateEmbeddingVector(vector)).toEqual({ ok: false, code });
	});

	test("profiles include model, dimension, and normalization version", () => {
		expect(
			embeddingProfileId("openai/text-embedding-3-small", 1024, "v1"),
		).toBe("openai/text-embedding-3-small:1024:v1");
	});
});
