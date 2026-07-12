import { describe, expect, test } from "bun:test";
import {
	forbiddenResultIdsAtK,
	mrrAtK,
	type OwnerCredentialMap,
	ownerCredentialHeaders,
	parseArgs,
	percentile,
	type RelevanceFixture,
	recallAtK,
	requireOwnerCredentials,
	resolveApiKey,
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
					crossLanguage: false,
				},
			],
			minimumExpandedProbes: 1,
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
		const expandedProbe = { ...probe, expanded: true };
		const summary = summarizeBenchmark(fixture, [probe, expandedProbe], 0);
		expect(summary.passed).toBe(true);
		expect(summary.recallAt10).toBe(1);
		expect(summary.mrrAt10).toBe(1);
		expect(summary.expandedProbeCount).toBe(1);
		expect(summary.gates.expandedProbeCoverage).toBe(true);
	});

	test("fails latency gates when fast or expanded samples are missing", () => {
		const fixture: RelevanceFixture = {
			version: "test",
			description: "test",
			documents: [],
			cases: [],
			minimumExpandedProbes: 1,
		};
		const summary = summarizeBenchmark(fixture, [], 0);
		expect(summary.fastP95Ms).toBeNull();
		expect(summary.expandedP95Ms).toBeNull();
		expect(summary.gates.latencySamples).toBe(false);
		expect(summary.gates.fastP95).toBe(false);
		expect(summary.gates.expandedP95).toBe(false);
		expect(summary.gates.expandedProbeCoverage).toBe(false);
	});

	test("fails when the metrics histogram cap makes the delta incomplete", () => {
		const fixture: RelevanceFixture = {
			version: "test",
			description: "test",
			documents: [],
			cases: [],
			minimumExpandedProbes: 1,
		};
		const summary = summarizeBenchmark(fixture, [], 0, 10, {
			fastSamples: [100],
			expandedSamples: [200],
			metricSamplesComplete: false,
			expansionEventCount: 1,
		});
		expect(summary.gates.latencySamples).toBe(false);
		expect(summary.passed).toBe(false);
	});

	test("requires an actual expanded probe/event and keeps cross-language scope explicit", () => {
		const fixture: RelevanceFixture = {
			version: "test",
			description: "test",
			documents: [],
			cases: [
				{
					id: "en",
					description: "normal",
					query: "test",
					relevantDocumentIds: ["doc"],
					ownerId: "owner",
					forbiddenDocumentIds: [],
					crossLanguage: false,
				},
				{
					id: "ru",
					description: "language mismatch",
					query: "тест",
					relevantDocumentIds: ["doc"],
					ownerId: "owner",
					forbiddenDocumentIds: [],
					crossLanguage: true,
				},
			],
			minimumExpandedProbes: 1,
		};
		const normal = {
			caseId: "en",
			query: "test",
			resultIds: ["doc"],
			latencyMs: 100,
			expanded: false,
			graphContributed: false,
			crossLanguageSuccess: true,
			allResultsHaveExplanations: true,
			forbiddenResultIds: [],
		};
		const summary = summarizeBenchmark(fixture, [normal], 0, 10, {
			expansionEventCount: 0,
		});
		expect(summary.crossLanguageCaseCount).toBe(0);
		expect(summary.gates.expandedProbeCoverage).toBe(false);

		const expanded = {
			...normal,
			caseId: "ru",
			query: "тест",
			expanded: true,
			crossLanguageSuccess: true,
		};
		const expandedSummary = summarizeBenchmark(
			fixture,
			[normal, expanded],
			0,
			10,
			{ expansionEventCount: 1, estimatedCostMicrounits: 12 },
		);
		expect(expandedSummary.crossLanguageCaseCount).toBe(1);
		expect(expandedSummary.crossLanguageSuccessCount).toBe(1);
		expect(expandedSummary.expansionCostPerQueryMicrounits).toBe(6);
	});

	test("rejects API-key command-line arguments and resolves only env/file input", () => {
		expect(() => parseArgs(["--api-key=secret"])).toThrow(
			"API keys must be provided via environment or --api-key-file/--api-key-stdin",
		);
		expect(() => parseArgs(["--api-key", "secret"])).toThrow();
		expect(resolveApiKey({ HIAI_DOCS_API_KEY: "env-secret" })).toBe(
			"env-secret",
		);
		expect(resolveApiKey({ BENCHMARK_API_KEY: "fallback-secret" })).toBe(
			"fallback-secret",
		);
		expect(
			resolveApiKey({
				HIAI_DOCS_API_KEY: " \t\n",
				BENCHMARK_API_KEY: " fallback-secret ",
			}),
		).toBe("fallback-secret");
		expect(
			resolveApiKey(
				{ HIAI_DOCS_API_KEY: "\t", BENCHMARK_API_KEY: " " },
				" file-secret ",
			),
		).toBe("file-secret");
	});

	test("bounds live provider probe concurrency", () => {
		expect(parseArgs([]).concurrency).toBe(2);
		expect(parseArgs(["--concurrency=1"]).concurrency).toBe(1);
		expect(parseArgs(["--concurrency", "99"]).concurrency).toBe(10);
	});

	test("requires distinct scoped credentials for every fixture owner", () => {
		const fixture: RelevanceFixture = {
			version: "test",
			description: "tenant scopes",
			documents: [],
			cases: [
				{
					id: "owner-a-case",
					description: "owner a",
					query: "a",
					relevantDocumentIds: [],
					ownerId: "owner-a",
					forbiddenDocumentIds: ["owner-b-doc"],
				},
				{
					id: "owner-b-case",
					description: "owner b",
					query: "b",
					relevantDocumentIds: [],
					ownerId: "owner-b",
					forbiddenDocumentIds: ["owner-a-doc"],
				},
			],
		};
		const credentials: OwnerCredentialMap = {
			"owner-a": "owner-a-token",
			"owner-b": { authorization: "Bearer owner-b-token" },
		};
		const resolved = requireOwnerCredentials(fixture, credentials);
		expect(resolved.get("owner-a")?.authorization).toBe("Bearer owner-a-token");
		expect(resolved.get("owner-b")?.authorization).toBe("Bearer owner-b-token");
		expect(resolved.get("owner-a")?.authorization).not.toBe(
			resolved.get("owner-b")?.authorization,
		);
		expect(ownerCredentialHeaders({ cookie: "session-owner-a" }).cookie).toBe(
			"session-owner-a",
		);
	});

	test("fails setup when a fixture owner has no scoped credential", () => {
		const fixture: RelevanceFixture = {
			version: "test",
			description: "tenant scopes",
			documents: [],
			cases: [
				{
					id: "owner-a-case",
					description: "owner a",
					query: "a",
					relevantDocumentIds: [],
					ownerId: "owner-a",
					forbiddenDocumentIds: [],
				},
				{
					id: "owner-b-case",
					description: "owner b",
					query: "b",
					relevantDocumentIds: [],
					ownerId: "owner-b",
					forbiddenDocumentIds: [],
				},
			],
		};
		expect(() =>
			requireOwnerCredentials(fixture, { "owner-a": "owner-a-token" }),
		).toThrow("owner-b");
	});

	test("checks forbidden IDs only within each owner top-k response", () => {
		expect(
			forbiddenResultIdsAtK(
				["owner-a-doc", "owner-a-other", "owner-b-doc"],
				["owner-b-doc"],
				2,
			),
		).toEqual([]);
		expect(
			forbiddenResultIdsAtK(["owner-a-doc", "owner-b-doc"], ["owner-b-doc"], 2),
		).toEqual(["owner-b-doc"]);
	});

	test("keeps the package benchmark command free of credential arguments", async () => {
		const packageJson = (await Bun.file(
			new URL("../../package.json", import.meta.url),
		).json()) as { scripts?: { [name: string]: string } };
		expect(packageJson.scripts?.["benchmark:search"] ?? "").not.toContain(
			"--api-key",
		);
	});
});
