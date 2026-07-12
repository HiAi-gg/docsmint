import { describe, expect, test } from "bun:test";
import { evaluateConfidence } from "../search/confidence";
import type {
	ChannelResult,
	QueryPlan,
	SearchCandidate,
} from "../search/types";

const plan: QueryPlan = {
	original: "English",
	normalized: "English",
	detectedLanguage: "en",
	translations: [],
	synonyms: [],
	concepts: [],
	namedEntities: [],
};

const candidate = (
	documentId: string,
	channel: SearchCandidate["channel"],
	rawScore?: number,
): SearchCandidate => ({
	documentId,
	channel,
	rank: 1,
	rawScore,
	evidence: channel,
});

const channels = (...candidates: SearchCandidate[]): ChannelResult[] =>
	candidates.map((item) => ({
		channel: item.channel,
		candidates: [item],
		durationMs: 1,
	}));

describe("search confidence", () => {
	test("requires expansion for empty candidates", () => {
		expect(evaluateConfidence([], plan, { vectorMinSimilarity: 0.35 })).toEqual(
			{
				confident: false,
				reasons: ["empty_candidates"],
			},
		);
	});

	test("requires expansion when lexical channels have no match", () => {
		const result = evaluateConfidence(
			channels(candidate("doc-1", "vector", 0.9)),
			plan,
			{ vectorMinSimilarity: 0.35 },
		);
		expect(result.confident).toBe(false);
		expect(result.reasons).toContain("no_lexical_match");
	});

	test("requires expansion for low vector similarity, disagreement, and language mismatch", () => {
		const result = evaluateConfidence(
			channels(
				candidate("doc-1", "exact", 1),
				candidate("doc-2", "vector", 0.2),
			),
			{ ...plan, detectedLanguage: "mixed" },
			{ vectorMinSimilarity: 0.35, languageMismatch: true },
		);
		expect(result.confident).toBe(false);
		expect(result.reasons).toEqual([
			"low_channel_agreement",
			"low_vector_similarity",
			"language_mismatch",
		]);
	});

	test("does not expand when exact and vector agree above threshold", () => {
		expect(
			evaluateConfidence(
				channels(
					candidate("doc-1", "exact", 1),
					candidate("doc-1", "vector", 0.88),
				),
				plan,
				{ vectorMinSimilarity: 0.35 },
			),
		).toEqual({ confident: true, reasons: [] });
	});

	test("uses the configured minimum channel agreement", () => {
		const result = evaluateConfidence(
			channels(
				candidate("doc-1", "exact"),
				candidate("doc-1", "fts"),
				candidate("doc-1", "vector", 0.88),
			),
			plan,
			{
				vectorMinSimilarity: 0.35,
				minChannelAgreement: 4,
			},
		);
		expect(result.confident).toBe(false);
		expect(result.reasons).toContain("low_channel_agreement");
	});

	test("is deterministic and provider-free", () => {
		const first = evaluateConfidence(
			channels(candidate("doc-1", "fts", 0.8)),
			plan,
			{
				vectorMinSimilarity: 0.35,
			},
		);
		const second = evaluateConfidence(
			channels(candidate("doc-1", "fts", 0.8)),
			plan,
			{
				vectorMinSimilarity: 0.35,
			},
		);
		expect(second).toEqual(first);
	});
});
