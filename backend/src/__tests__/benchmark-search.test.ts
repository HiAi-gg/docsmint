import { describe, expect, test } from "bun:test";
import {
	mrrAtK,
	percentile,
	type RelevanceFixture,
	recallAtK,
	type SearchProbe,
	summarizeBenchmark,
} from "../scripts/benchmark-search";

describe("search benchmark evaluation math", () => {
	test("calculates recall, MRR, and nearest-rank percentile", () => {
		expect(recallAtK(["doc-b", "doc-a"], ["doc-a"], 10)).toBe(1);
		expect(mrrAtK(["doc-b", "doc-a"], ["doc-a"], 10)).toBe(0.5);
		expect(percentile([100, 200, 300, 400], 0.95)).toBe(400);
	});

	test("keeps Unicode-escaped fixture queries decoded at runtime", async () => {
		const fixture = (await Bun.file(
			new URL("../../tests/fixtures/search-relevance.json", import.meta.url),
		).json()) as RelevanceFixture;
		const russian = fixture.cases.find((item) => item.id === "ru-english");
		expect(russian?.query).toBe("английский");
	});

	test("fails the summary when release gates are violated", () => {
		const fixture: RelevanceFixture = {
			version: "test",
			description: "test",
			documents: [],
			cases: [
				{
					id: "case-1",
					description: "test",
					query: "test",
					relevantDocumentIds: ["expected"],
					ownerId: "owner",
					forbiddenDocumentIds: ["private"],
				},
			],
		};
		const probe: SearchProbe = {
			caseId: "case-1",
			query: "test",
			resultIds: ["private"],
			latencyMs: 700,
			expanded: false,
			graphContributed: false,
			allResultsHaveExplanations: false,
			forbiddenResultIds: ["private"],
		};
		const summary = summarizeBenchmark(fixture, [probe], 1);
		expect(summary.passed).toBe(false);
		expect(summary.gates.invalidVectors).toBe(false);
		expect(summary.gates.tenantLeakage).toBe(false);
		expect(summary.gates.explanations).toBe(false);
	});

	test("passes the default gates for a complete deterministic probe", () => {
		const fixture: RelevanceFixture = {
			version: "test",
			description: "test",
			documents: [],
			cases: [
				{
					id: "case-1",
					description: "test",
					query: "test",
					relevantDocumentIds: ["expected"],
					ownerId: "owner",
					forbiddenDocumentIds: ["private"],
				},
			],
		};
		const probe: SearchProbe = {
			caseId: "case-1",
			query: "test",
			resultIds: ["expected"],
			latencyMs: 100,
			expanded: false,
			graphContributed: true,
			allResultsHaveExplanations: true,
			forbiddenResultIds: [],
		};
		const summary = summarizeBenchmark(fixture, [probe], 0);
		expect(summary.passed).toBe(true);
		expect(summary.recallAt10).toBe(1);
		expect(summary.mrrAt10).toBe(1);
	});
});
