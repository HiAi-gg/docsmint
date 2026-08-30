import { describe, expect, test } from "bun:test";
import { applyRerankOrder, normalizeRerankText } from "../search/rerank";
import type { RankedSearchResult } from "../search/types";

function ranked(ids: string[]): RankedSearchResult[] {
	return ids.map((documentId, index) => ({
		documentId,
		score: 1 - index * 0.01,
		channels: ["fts"],
		explanations: [],
	}));
}

describe("rerank helpers", () => {
	test("strips data URIs and caps candidate text", () => {
		const text = normalizeRerankText(
			"Title",
			`hello data:image/png;base64,AAAA ${"x".repeat(80)}`,
			20,
		);
		expect(text).not.toContain("data:image");
		expect(text.length).toBeLessThanOrEqual(20);
	});

	test("reorders the top window and keeps the tail", () => {
		const items = ranked(["a", "b", "c", "d"]);
		const next = applyRerankOrder(
			items,
			[
				{ id: "c", score: 0.9, rank: 1 },
				{ id: "a", score: 0.2, rank: 2 },
			],
			3,
		);
		expect(next.map((item) => item.documentId)).toEqual(["c", "a", "b", "d"]);
	});

	test("keeps RRF order when hits are empty", () => {
		const items = ranked(["a", "b"]);
		expect(applyRerankOrder(items, [], 10)).toEqual(items);
	});
});
