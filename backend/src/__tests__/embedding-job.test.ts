import { describe, expect, test } from "bun:test";
import {
	decodeEmbeddingJob,
	encodeEmbeddingJob,
	retryDelayMs,
} from "../embedding/job";

describe("embedding queue job retry contract", () => {
	test("keeps legacy plain document ids readable", () => {
		expect(decodeEmbeddingJob("doc-1")).toEqual({
			documentId: "doc-1",
			attempt: 0,
		});
	});

	test("round trips retry metadata", () => {
		const job = { documentId: "doc-2", attempt: 1 };
		expect(decodeEmbeddingJob(encodeEmbeddingJob(job))).toEqual(job);
	});

	test("bounds retry attempts with short backoff", () => {
		expect(retryDelayMs(0)).toBe(1_000);
		expect(retryDelayMs(1)).toBe(5_000);
		expect(retryDelayMs(2)).toBeNull();
	});
});
