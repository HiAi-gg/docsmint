import { describe, expect, test } from "bun:test";
import { fuseCandidates } from "../search/rrf";
import type { SearchCandidate } from "../search/types";

const candidate = (
	documentId: string,
	channel: SearchCandidate["channel"],
	rank: number,
	rawScore?: number,
	queryVariant?: string,
): SearchCandidate => ({
	documentId,
	channel,
	rank,
	rawScore,
	queryVariant,
	evidence: `${channel}:${documentId}`,
});

describe("deterministic reciprocal rank fusion", () => {
	test("uses the default RRF formula and exact-title boost", () => {
		const [result] = fuseCandidates([candidate("doc-a", "exact", 1)], {
			rrfK: 60,
			exactBoost: 0.02,
		});
		expect(result?.score).toBeCloseTo(1 / 61 + 0.02);
		expect(result?.channels).toEqual(["exact"]);
	});

	test("boosts agreement across two channels", () => {
		const [result] = fuseCandidates(
			[candidate("doc-a", "exact", 1), candidate("doc-a", "vector", 1, 0.9)],
			{ rrfK: 60, channelAgreementBoost: 0.01 },
		);
		expect(result?.score).toBeCloseTo(1 / 61 + 1 / 61 + 0.02 + 0.01);
		expect(
			result?.explanations.map((explanation) => explanation.channel),
		).toEqual(["exact", "vector"]);
	});

	test("caps graph-only contribution and does not overtake a strong exact hit", () => {
		const results = fuseCandidates(
			[candidate("graph-doc", "graph", 1), candidate("exact-doc", "exact", 1)],
			{ rrfK: 60, exactBoost: 0.02, graphMaxContribution: 0.03 },
		);
		expect(results[0]?.documentId).toBe("exact-doc");
		expect(
			results.find((result) => result.documentId === "graph-doc")?.score,
		).toBeLessThanOrEqual(0.03);
	});

	test("collapses duplicate chunks, filters weak vectors, and breaks ties by document ID", () => {
		const results = fuseCandidates(
			[
				candidate("doc-b", "vector", 1, 0.8),
				candidate("doc-b", "vector", 2, 0.8),
				candidate("doc-a", "vector", 1, 0.8),
				candidate("weak", "vector", 1, 0.1),
				candidate("nan", "vector", 1, Number.NaN),
			],
			{ rrfK: 60, vectorMinSimilarity: 0.35 },
		);
		expect(results.map((result) => result.documentId)).toEqual([
			"doc-a",
			"doc-b",
		]);
		expect(results[0]?.score).toBeCloseTo(results[1]?.score ?? 0);
		expect(
			results.every(
				(result) => result.documentId !== "weak" && result.documentId !== "nan",
			),
		).toBe(true);
	});

	test("derives explanations from evidence and query variants", () => {
		const [result] = fuseCandidates([
			candidate("doc-a", "expanded_vector", 1, 0.8, "English"),
		]);
		expect(result?.explanations).toEqual([
			{
				channel: "expanded_vector",
				label: "Semantic match",
				queryVariant: "English",
			},
		]);
	});
});
