/**
 * Phase 5.3 — Unit tests for Redis-based entity extraction dedup and
 * incremental changedIndices filtering.
 *
 * Uses all-dynamic imports so mock.module can be set before any module
 * resolution. mock.module is called in beforeAll + beforeEach so that
 * dynamic imports inside tests resolve to our mocks regardless of what
 * other test files have cached.
 */

import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

// -------------------------------------------------------------------------
// Mock state
// -------------------------------------------------------------------------

const redisSetCalls: Array<{
	key: string;
	value: string;
	mode: string;
	ttl: number;
	flag: string;
}> = [];
let redisSetNextResult: string | null = "OK";
let redisSetShouldThrow = false;

const redisSetMock = mock(
	async (
		key: string,
		value: string,
		mode: string,
		ttl: number,
		flag: string,
	): Promise<string | null> => {
		if (redisSetShouldThrow) throw new Error("ECONNREFUSED");
		redisSetCalls.push({ key, value, mode, ttl, flag });
		return redisSetNextResult;
	},
);

let getGraphDbCallCount = 0;
const getGraphDbMock = mock(async (): Promise<null> => {
	getGraphDbCallCount++;
	return null;
});

const fakeGraphInit = {
	getGraphDb: getGraphDbMock,
	_resetGraphForTests: () => {
		getGraphDbCallCount = 0;
	},
};

function applyMocks(): void {
	// Mock config so GRAPH_EXTRACT_ENABLED=true (overrides any global mock).
	// Include GRAPH_EXTRACT_MIN_CONFIDENCE so downstream consumers
	// (notably `src/__tests__/graph-extract.test.ts`'s threshold-filter
	// case) see a real threshold rather than `undefined` — `mock.module`
	// is process-global in Bun, so this stub persists across test files
	// in the same process.
	mock.module("../lib/config", () => ({
		config: {
			GRAPH_EXTRACT_ENABLED: true,
			GRAPH_EXTRACT_MIN_CONFIDENCE: 0.5,
			REEMBED_MIN_WORD_CHANGES: 20,
			REEMBED_MIN_CHAR_CHANGES: 100,
			REEMBED_MAX_IDLE_HOURS: 24,
			METADATA_REEMBED_CRON_INTERVAL_MINUTES: 1,
			REEMBED_CRON_INTERVAL_MINUTES: 15,
		},
	}));
	// Intercept redis import so extractEntities gets our fake set()
	mock.module("../lib/redis", () => ({ redis: { set: redisSetMock } }));
	// Intercept graph/init so getGraphDb is controllable
	mock.module("../lib/graph/init", () => fakeGraphInit);
}

beforeAll(applyMocks);
beforeEach(() => {
	applyMocks();
	redisSetCalls.length = 0;
	redisSetNextResult = "OK";
	redisSetShouldThrow = false;
	getGraphDbCallCount = 0;
	redisSetMock.mockClear();
	getGraphDbMock.mockClear();
});

// -----------------------------------------------------------------------
// extractEntities Redis dedup
// -----------------------------------------------------------------------

describe("Phase 5.3 — extractEntities Redis dedup", () => {
	test("same chunkHash/chunkIndex: second call short-circuits via Redis", async () => {
		const { extractEntities } = await import("../lib/graph/extract-entities");

		// First call: Redis returns "OK" (slot claimed), proceeds to AGE gate
		await extractEntities("same text", "doc-1", {
			chunkHash: "hash-X",
			chunkIndex: 0,
		});
		expect(redisSetCalls.length).toBe(1);
		expect(redisSetCalls[0]?.key).toBe("hiai-docs:extract:done:doc-1:0:hash-X");

		// Second call: Redis returns null (key exists) -> short-circuits
		redisSetNextResult = null;
		const r2 = await extractEntities("same text", "doc-1", {
			chunkHash: "hash-X",
			chunkIndex: 0,
		});
		expect(r2).toEqual([]);
		expect(redisSetCalls.length).toBe(2);
		// Second call did NOT reach getGraphDb (short-circuited before AGE gate)
		expect(getGraphDbCallCount).toBe(1);
	});

	test("different hash at same chunkIndex = independent slot", async () => {
		const { extractEntities } = await import("../lib/graph/extract-entities");

		await extractEntities("alpha", "doc-1", {
			chunkHash: "hash-A",
			chunkIndex: 0,
		});
		await extractEntities("alpha-v2", "doc-1", {
			chunkHash: "hash-B",
			chunkIndex: 0,
		});

		expect(redisSetCalls.length).toBe(2);
		expect(redisSetCalls[1]?.key).toBe("hiai-docs:extract:done:doc-1:0:hash-B");
		expect(getGraphDbCallCount).toBe(2);
	});

	test("same hash at different chunkIndices = independent slots", async () => {
		const { extractEntities } = await import("../lib/graph/extract-entities");

		await extractEntities("text", "doc-1", {
			chunkHash: "hash-X",
			chunkIndex: 0,
		});
		await extractEntities("text", "doc-1", {
			chunkHash: "hash-X",
			chunkIndex: 7,
		});

		expect(redisSetCalls.length).toBe(2);
		expect(redisSetCalls[0]?.key).toBe("hiai-docs:extract:done:doc-1:0:hash-X");
		expect(redisSetCalls[1]?.key).toBe("hiai-docs:extract:done:doc-1:7:hash-X");
		expect(getGraphDbCallCount).toBe(2);
	});

	test("Redis SET failure falls through to extraction (best-effort)", async () => {
		redisSetShouldThrow = true;
		const { extractEntities } = await import("../lib/graph/extract-entities");
		const r = await extractEntities("text", "doc-1", {
			chunkHash: "hash-1",
			chunkIndex: 0,
		});
		expect(r).toEqual([]);
		expect(getGraphDbCallCount).toBe(1);
	});
});

// -----------------------------------------------------------------------
// Backward compatibility (no chunkHash/chunkIndex)
// -----------------------------------------------------------------------

describe("Phase 5.3 — backward compat (no chunkHash/chunkIndex)", () => {
	test("omitting both chunkHash and chunkIndex = no Redis interaction", async () => {
		const { extractEntities } = await import("../lib/graph/extract-entities");
		const r = await extractEntities("text", "doc-2");
		expect(r).toEqual([]);
		expect(redisSetCalls.length).toBe(0);
		expect(getGraphDbCallCount).toBe(1);
	});

	test("chunkHash alone (no chunkIndex) = no Redis", async () => {
		const { extractEntities } = await import("../lib/graph/extract-entities");
		const r = await extractEntities("text", "doc-2", {
			chunkHash: "hash-only",
		});
		expect(r).toEqual([]);
		expect(redisSetCalls.length).toBe(0);
		expect(getGraphDbCallCount).toBe(1);
	});

	test("chunkIndex alone (no chunkHash) = no Redis", async () => {
		const { extractEntities } = await import("../lib/graph/extract-entities");
		const r = await extractEntities("text", "doc-2", { chunkIndex: 0 });
		expect(r).toEqual([]);
		expect(redisSetCalls.length).toBe(0);
		expect(getGraphDbCallCount).toBe(1);
	});
});

// -----------------------------------------------------------------------
// runEntityExtraction changedIndices filtering
// -----------------------------------------------------------------------

describe("Phase 5.3 — runEntityExtraction changedIndices", () => {
	test("processes only indices in changedIndices", async () => {
		const { runEntityExtraction } = await import("../embedding/worker");

		const embeddings = [
			{ chunkText: "zero", embedding: [0.1] },
			{ chunkText: "one", embedding: [0.2] },
			{ chunkText: "two", embedding: [0.3] },
			{ chunkText: "three", embedding: [0.4] },
			{ chunkText: "four", embedding: [0.5] },
		];

		await runEntityExtraction(embeddings, "doc-1", new Set([1, 3]));

		expect(redisSetCalls.length).toBe(2);
		const indices = redisSetCalls
			.map((c) => Number(c.key.split(":").at(-2)))
			.sort();
		expect(indices).toEqual([1, 3]);
	});

	test("without changedIndices: processes every chunk (legacy callers)", async () => {
		const { runEntityExtraction } = await import("../embedding/worker");

		const embeddings = [
			{ chunkText: "zero", embedding: [0.1] },
			{ chunkText: "one", embedding: [0.2] },
			{ chunkText: "two", embedding: [0.3] },
		];

		await runEntityExtraction(embeddings, "doc-1");
		expect(redisSetCalls.length).toBe(3);
	});

	test("out-of-range indices in changedIndices are silently filtered", async () => {
		const { runEntityExtraction } = await import("../embedding/worker");

		const embeddings = [
			{ chunkText: "zero", embedding: [0.1] },
			{ chunkText: "one", embedding: [0.2] },
		];

		await runEntityExtraction(embeddings, "doc-1", new Set([0, 100, -1]));
		expect(redisSetCalls.length).toBe(1);
	});
});
