import { describe, expect, test } from "bun:test";
import { rankChunkRows, restrictSearchResponse } from "../api/routes/search";

describe("search route chunk hydration", () => {
	test("keeps the top three finite cosine scores, not index order or zero placeholders", () => {
		const ranked = rankChunkRows([
			{ document_id: "doc-1", chunk_index: 0, chunk_text: "low", score: 0.2 },
			{ document_id: "doc-1", chunk_index: 4, chunk_text: "best", score: 0.95 },
			{ document_id: "doc-1", chunk_index: 2, chunk_text: "mid", score: 0.7 },
			{ document_id: "doc-1", chunk_index: 3, chunk_text: "third", score: 0.5 },
			{
				document_id: "doc-1",
				chunk_index: 9,
				chunk_text: "nan",
				score: Number.NaN,
			},
		]);

		expect(ranked.get("doc-1")?.map((chunk) => chunk.chunkText)).toEqual([
			"best",
			"mid",
			"third",
		]);
		expect(ranked.get("doc-1")?.map((chunk) => chunk.score)).toEqual([
			0.95, 0.7, 0.5,
		]);
	});
});

describe("category-scoped search visibility", () => {
	test("removes an out-of-category strongest result before hydration and counting", () => {
		const restricted = restrictSearchResponse(
			{
				items: [
					{ documentId: "hidden-strongest", score: 100 },
					{ documentId: "allowed-weaker", score: 1 },
				],
				total: 2,
				visibleTotal: 2,
				visibleDocumentIds: ["hidden-strongest", "allowed-weaker"],
			},
			["allowed-weaker"],
		);

		expect(restricted.items).toEqual([
			{ documentId: "allowed-weaker", score: 1 },
		]);
		expect(restricted.total).toBe(1);
		expect(restricted.visibleTotal).toBe(1);
		expect(restricted.visibleDocumentIds).toEqual(["allowed-weaker"]);
	});
});
