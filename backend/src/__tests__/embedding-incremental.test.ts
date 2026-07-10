import { describe, expect, test } from "bun:test";
import { needsChunkRefresh } from "../embedding/incremental";

describe("incremental embedding refresh", () => {
	const valid = {
		chunkHash: "hash-a",
		embedding: [0.1, 0, -0.2],
		embeddingModel: "bge-m3",
	};

	test("keeps a valid unchanged vector from the current model", () => {
		expect(needsChunkRefresh(valid, "hash-a", "bge-m3")).toBe(false);
	});

	test("replaces a zero vector even when content hash is unchanged", () => {
		expect(
			needsChunkRefresh({ ...valid, embedding: [0, 0, 0] }, "hash-a", "bge-m3"),
		).toBe(true);
	});

	test("replaces vectors from a different model", () => {
		expect(
			needsChunkRefresh(
				{ ...valid, embeddingModel: "old-model" },
				"hash-a",
				"bge-m3",
			),
		).toBe(true);
	});

	test("replaces missing and content-changed chunks", () => {
		expect(needsChunkRefresh(undefined, "hash-a", "bge-m3")).toBe(true);
		expect(needsChunkRefresh(valid, "hash-b", "bge-m3")).toBe(true);
	});
});
