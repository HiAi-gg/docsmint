import { describe, expect, mock, test } from "bun:test";
import type { TenantContext } from "@hiai-docs/db/with-tenant";
import type { EmbeddingResult } from "../embedding/result";
import { getMetrics, METRIC_NAMES, resetMetrics } from "../lib/metrics";
import {
	resolveSearchEmbedding,
	searchDocuments,
} from "../search/orchestrator";
import type {
	ChannelResult,
	QueryPlan,
	SearchCandidate,
	SearchChannel,
} from "../search/types";

const OWNER = "00000000-0000-4000-8000-000000000001";
const ctx: TenantContext = { userId: OWNER, role: "user" };

const queryEmbedding: EmbeddingResult = {
	ok: true,
	vector: Array.from({ length: 1024 }, () => 0.01),
	model: "openai/text-embedding-3-small",
	provider: "primary",
	dimensions: 1024,
	profile: "openai/text-embedding-3-small:1024:v1",
};

test("bounds a stalled search embedding without failing lexical retrieval", async () => {
	const stalled = new Promise<EmbeddingResult>(() => undefined);
	const started = performance.now();
	expect(await resolveSearchEmbedding(stalled, 5)).toEqual({
		ok: false,
		code: "provider_error",
	});
	expect(performance.now() - started).toBeLessThan(100);
});

function candidate(
	documentId: string,
	channel: SearchChannel,
	rank = 1,
	rawScore?: number,
): SearchCandidate {
	return {
		documentId,
		channel,
		rank,
		rawScore,
		evidence: `${channel}:${documentId}`,
	};
}

function channels(
	values: Partial<Record<SearchChannel, SearchCandidate[]>>,
): ChannelResult[] {
	return [
		"exact",
		"fts",
		"fuzzy",
		"vector",
		"expanded_fts",
		"expanded_fuzzy",
		"expanded_vector",
	].map((channel) => ({
		channel: channel as SearchChannel,
		candidates: values[channel as SearchChannel] ?? [],
		durationMs: 1,
	}));
}

function expansion(plan: QueryPlan, variants = ["English"] as string[]) {
	return {
		model: "mistralai/ministral-14b-2512",
		plan: {
			...plan,
			translations: variants,
			synonyms: [],
			concepts: ["authentication"],
			namedEntities: ["English"],
		},
	};
}

describe("automatic GraphRAG search orchestration", () => {
	test("retrieves enough candidates to rank the requested page window", async () => {
		let retrievedLimit: number | undefined;
		await searchDocuments(
			ctx,
			{
				query: "deep page",
				page: 5,
				limit: 100,
				graphEnabled: false,
				rerankEnabled: false,
			},
			{
				retrieveFast: async (_ctx, _plan, options) => {
					retrievedLimit = options?.limit;
					return channels({});
				},
				expand: async () => null,
			},
		);

		expect(retrievedLimit).toBe(500);
	});

	test("filters authorized candidates before pagination so a page stays full", async () => {
		const response = await searchDocuments(
			ctx,
			{
				rerankEnabled: false,
				query: "Vladislav",
				page: 1,
				limit: 5,
				visibilityScope: {
					kind: "tenant",
					ownerId: OWNER,
					includePublic: true,
				},
			},
			{
				retrieveFast: async () =>
					channels({
						exact: Array.from({ length: 8 }, (_, index) =>
							candidate(`doc-${index + 1}`, "exact", index + 1),
						),
					}),
				expand: async () => null,
				retrieveGraph: async () => [],
				filterRanked: async (_ctx, items) =>
					items.filter(
						(item) =>
							item.documentId !== "doc-1" && item.documentId !== "doc-2",
					),
			},
		);

		expect(response.items.map((item) => item.documentId)).toEqual([
			"doc-3",
			"doc-4",
			"doc-5",
			"doc-6",
			"doc-7",
		]);
		expect(response.total).toBe(6);
	});

	test("rejects foreign direct, expanded, and graph candidates before fusion and AGE seeding", async () => {
		let graphSeeds: string[] = [];
		const response = await searchDocuments(
			ctx,
			{
				rerankEnabled: false,
				query: "scoped",
				documentIds: ["inherited-folder-doc"],
			},
			{
				retrieveFast: async () =>
					channels({
						exact: [
							candidate("foreign-direct", "exact", 1),
							candidate("inherited-folder-doc", "exact", 2),
						],
						vector: [candidate("foreign-vector", "vector", 1, 0.99)],
					}),
				expand: async (plan) => expansion(plan, ["scope"]),
				retrieveExpanded: async () =>
					channels({
						expanded_fts: [candidate("foreign-expanded", "expanded_fts")],
					}),
				retrieveGraph: async (_ctx, request) => {
					graphSeeds = request.documentSeeds;
					return [candidate("foreign-graph", "graph")];
				},
			},
		);

		expect(graphSeeds).toEqual(["inherited-folder-doc"]);
		expect(response.items.map((item) => item.documentId)).toEqual([
			"inherited-folder-doc",
		]);
	});

	test("shares one request embedding with vector retrieval and hydration", async () => {
		const provider = mock(async () => queryEmbedding);
		let requestEmbedding: EmbeddingResult | undefined;
		const response = await searchDocuments(
			ctx,
			{ query: "English", limit: 10, rerankEnabled: false },
			{
				getEmbedding: provider,
				retrieveFast: async (_ctx, _plan, options = {}) => {
					requestEmbedding = await options.getEmbedding?.("English");
					return channels({
						vector: [candidate("doc-1", "vector", 1, 0.9)],
					});
				},
				expand: async () => null,
				retrieveGraph: async () => [],
			},
		);
		expect(provider).toHaveBeenCalledTimes(1);
		expect(requestEmbedding).toEqual(queryEmbedding);
		expect(response.queryEmbedding).toEqual(queryEmbedding);
	});

	test("caches a provider rejection as a failure result for hydration", async () => {
		const provider = mock(async () => {
			throw new Error("embedding provider unavailable");
		});
		let first: EmbeddingResult | undefined;
		let second: EmbeddingResult | undefined;
		const response = await searchDocuments(
			ctx,
			{ query: "English", limit: 10, rerankEnabled: false },
			{
				getEmbedding: provider,
				retrieveFast: async (_ctx, _plan, options = {}) => {
					first = await options.getEmbedding?.("English");
					second = await options.getEmbedding?.("English");
					return channels({});
				},
				expand: async () => null,
				retrieveGraph: async () => [],
			},
		);
		expect(provider).toHaveBeenCalledTimes(1);
		expect(first).toEqual({ ok: false, code: "provider_error" });
		expect(second).toEqual(first);
		expect(response.queryEmbedding).toEqual(first);
	});

	test("confident exact plus vector fast pass does not call the LLM", async () => {
		const expand = mock(async () => null);
		const graph = mock(async () => [] as SearchCandidate[]);
		const response = await searchDocuments(
			ctx,
			{ query: "English", limit: 10, rerankEnabled: false },
			{
				retrieveFast: async () =>
					channels({
						exact: [candidate("doc-1", "exact")],
						vector: [candidate("doc-1", "vector", 1, 0.9)],
					}),
				expand,
				retrieveGraph: graph,
			},
		);
		expect(expand).not.toHaveBeenCalled();
		expect(graph).toHaveBeenCalledTimes(1);
		expect(response.items[0]?.documentId).toBe("doc-1");
	});

	test("Russian low-confidence pass expands once and reruns expanded channels", async () => {
		const expand = mock(async (plan: QueryPlan) =>
			expansion(plan, ["English"]),
		);
		const expanded = mock(async () =>
			channels({ expanded_fts: [candidate("doc-2", "expanded_fts")] }),
		);
		const response = await searchDocuments(
			ctx,
			{ query: "английский", limit: 10, rerankEnabled: false },
			{
				retrieveFast: async () => channels({}),
				expand,
				retrieveExpanded: expanded,
				retrieveGraph: async () => [],
			},
		);
		expect(expand).toHaveBeenCalledTimes(1);
		expect(expanded).toHaveBeenCalledTimes(1);
		expect(response.diagnostics.expansionAttempted).toBe(true);
		expect(response.diagnostics.expansionUsed).toBe(true);
		expect(response.diagnostics.crossLanguageSuccess).toBe(true);
		expect(response.items[0]?.documentId).toBe("doc-2");
	});

	test("retrieves a language-list document when query embeddings are unavailable", async () => {
		const languageDoc = candidate("language-list", "expanded_fts");
		const response = await searchDocuments(
			ctx,
			{ query: "разные языки", limit: 10, rerankEnabled: false },
			{
				getEmbedding: async () => ({ ok: false, code: "provider_error" }),
				retrieveFast: async () => channels({ vector: [] }),
				expand: async (plan) => ({
					model: "local-lexicon-v1",
					plan: { ...plan, concepts: ["english", "french", "portuguese"] },
				}),
				retrieveExpanded: async (_tenant, plan) => {
					expect(plan.concepts).toContain("french");
					return channels({ expanded_fts: [languageDoc] });
				},
				retrieveGraph: async () => [],
			},
		);
		expect(response.items.map((item) => item.documentId)).toContain(
			"language-list",
		);
		expect(response.diagnostics.crossLanguageSuccess).toBe(true);
	});

	test("GraphRAG is called without a request flag", async () => {
		const graph = mock(async () => [candidate("graph-doc", "graph")]);
		const response = await searchDocuments(
			ctx,
			{ query: "topic", rerankEnabled: false },
			{
				retrieveFast: async () =>
					channels({ fts: [candidate("direct", "fts")] }),
				expand: async () => null,
				retrieveGraph: graph,
			},
		);
		expect(graph).toHaveBeenCalledTimes(1);
		expect(response.diagnostics.graphAttempted).toBe(true);
	});

	test("allows the privileged benchmark profile to measure RAG without graph traversal", async () => {
		const graph = mock(async () => [candidate("graph-doc", "graph")]);
		const response = await searchDocuments(
			ctx,
			{
				rerankEnabled: false,
				query: "topic",
				graphEnabled: false,
			},
			{
				retrieveFast: async () =>
					channels({ fts: [candidate("direct", "fts")] }),
				expand: async () => null,
				retrieveGraph: graph,
			},
		);
		expect(graph).not.toHaveBeenCalled();
		expect(response.diagnostics.graphAttempted).toBe(false);
		expect(response.items.map((item) => item.documentId)).toEqual(["direct"]);
	});

	test("counts graph contribution only when a graph candidate reaches final items", async () => {
		resetMetrics();
		await searchDocuments(
			ctx,
			{ query: "topic", page: 2, limit: 1, rerankEnabled: false },
			{
				retrieveFast: async () => channels({}),
				expand: async () => null,
				retrieveGraph: async () => [candidate("graph-only", "graph")],
			},
		);
		expect(
			getMetrics()[METRIC_NAMES.SEARCH_GRAPH_CONTRIBUTION_TOTAL] ?? 0,
		).toBe(0);
		resetMetrics();
	});

	test("graph-only results remain below a strong exact result", async () => {
		const response = await searchDocuments(
			ctx,
			{ query: "Exact title", rerankEnabled: false },
			{
				retrieveFast: async () =>
					channels({ exact: [candidate("exact", "exact")] }),
				expand: async () => null,
				retrieveGraph: async () => [candidate("related", "graph")],
			},
		);
		expect(response.items.map((item) => item.documentId)).toEqual([
			"exact",
			"related",
		]);
	});

	test("provider timeout returns fast-pass results", async () => {
		const response = await searchDocuments(
			ctx,
			{ query: "таймаут", rerankEnabled: false },
			{
				retrieveFast: async () => channels({ fts: [candidate("fast", "fts")] }),
				expand: async () => {
					throw new Error("timeout");
				},
				retrieveGraph: async () => [],
			},
		);
		expect(response.items[0]?.documentId).toBe("fast");
		expect(response.diagnostics.expansionAttempted).toBe(true);
	});

	test("graph failure returns fused direct results", async () => {
		const response = await searchDocuments(
			ctx,
			{ query: "direct", rerankEnabled: false },
			{
				retrieveFast: async () =>
					channels({ exact: [candidate("direct", "exact")] }),
				expand: async () => null,
				retrieveGraph: async () => {
					throw new Error("AGE unavailable");
				},
			},
		);
		expect(response.items[0]?.documentId).toBe("direct");
		expect(response.diagnostics.graphFailed).toBe(true);
	});

	test("empty healthy channels report no relevant candidates", async () => {
		const response = await searchDocuments(
			ctx,
			{ query: "missing", rerankEnabled: false },
			{
				retrieveFast: async () => channels({}),
				expand: async () => null,
				retrieveGraph: async () => [],
			},
		);
		expect(response.items).toEqual([]);
		expect(response.diagnostics.reason).toBe("no_relevant_candidates");
	});

	test("every adapter receives the same tenant context", async () => {
		const seen: TenantContext[] = [];
		const response = await searchDocuments(
			ctx,
			{ query: "scope", rerankEnabled: false },
			{
				retrieveFast: async (received) => {
					seen.push(received);
					return channels({});
				},
				expand: async () => null,
				retrieveGraph: async (received) => {
					seen.push(received);
					return [];
				},
			},
		);
		expect(response.items).toEqual([]);
		expect(seen).toHaveLength(2);
		expect(seen.every((received) => received === ctx)).toBe(true);
	});

	test("empty direct pass seeds AGE from expanded concepts and entities", async () => {
		let graphRequest:
			| { documentSeeds: string[]; queryPlan: QueryPlan }
			| undefined;
		const planExpansion = mock(async (plan: QueryPlan) => expansion(plan, []));
		const response = await searchDocuments(
			ctx,
			{ query: "русский термин", rerankEnabled: false },
			{
				retrieveFast: async () => channels({}),
				expand: planExpansion,
				retrieveExpanded: async () => [],
				retrieveGraph: async (_ctx, request) => {
					graphRequest = request;
					return [candidate("graph-concept", "graph")];
				},
			},
		);
		expect(graphRequest?.documentSeeds).toEqual([]);
		expect(graphRequest?.queryPlan.concepts).toContain("authentication");
		expect(response.items[0]?.documentId).toBe("graph-concept");
	});
});

describe("optional cross-encoder rerank", () => {
	test("disabled rerank keeps RRF order", async () => {
		const rerank = mock(async () => null);
		const response = await searchDocuments(
			ctx,
			{
				query: "English",
				limit: 10,
				graphEnabled: false,
				rerankEnabled: false,
			},
			{
				retrieveFast: async () =>
					channels({
						exact: [candidate("doc-a", "exact", 1)],
						fts: [candidate("doc-b", "fts", 1)],
					}),
				expand: async () => null,
				retrieveGraph: async () => [],
				rerank,
			},
		);
		expect(rerank).not.toHaveBeenCalled();
		expect(response.diagnostics.rerankAttempted).toBe(false);
		expect(response.items.map((item) => item.documentId)).toEqual([
			"doc-a",
			"doc-b",
		]);
	});

	test("rerank reorders the RRF prefix and falls back on provider null", async () => {
		const reordered = await searchDocuments(
			ctx,
			{
				query: "English",
				limit: 10,
				graphEnabled: false,
				rerankEnabled: true,
			},
			{
				retrieveFast: async () =>
					channels({
						exact: [candidate("doc-a", "exact", 1)],
						fts: [candidate("doc-b", "fts", 1)],
					}),
				expand: async () => null,
				retrieveGraph: async () => [],
				loadRerankTexts: async () =>
					new Map([
						["doc-a", "alpha"],
						["doc-b", "beta"],
					]),
				rerank: async () => ({
					model: "voyageai/rerank-2.5",
					hits: [
						{ id: "doc-b", score: 0.9, rank: 1 },
						{ id: "doc-a", score: 0.1, rank: 2 },
					],
				}),
			},
		);
		expect(reordered.items.map((item) => item.documentId)).toEqual([
			"doc-b",
			"doc-a",
		]);
		expect(reordered.diagnostics.rerankUsed).toBe(true);

		const fallback = await searchDocuments(
			ctx,
			{
				query: "English",
				limit: 10,
				graphEnabled: false,
				rerankEnabled: true,
			},
			{
				retrieveFast: async () =>
					channels({
						exact: [candidate("doc-a", "exact", 1)],
						fts: [candidate("doc-b", "fts", 1)],
					}),
				expand: async () => null,
				retrieveGraph: async () => [],
				loadRerankTexts: async () =>
					new Map([
						["doc-a", "alpha"],
						["doc-b", "beta"],
					]),
				rerank: async () => null,
			},
		);
		expect(fallback.items.map((item) => item.documentId)).toEqual([
			"doc-a",
			"doc-b",
		]);
		expect(fallback.diagnostics.rerankFallback).toBe(true);
	});

	test("graph-after-rerank seeds AGE from the reranked prefix", async () => {
		let seeds: string[] = [];
		await searchDocuments(
			ctx,
			{
				query: "English",
				limit: 10,
				rerankEnabled: true,
				rerankGraphPosition: "after",
			},
			{
				retrieveFast: async () =>
					channels({
						exact: [candidate("doc-a", "exact", 1)],
						fts: [candidate("doc-b", "fts", 1)],
					}),
				expand: async () => null,
				loadRerankTexts: async () =>
					new Map([
						["doc-a", "alpha"],
						["doc-b", "beta"],
					]),
				rerank: async () => ({
					model: "voyageai/rerank-2.5",
					hits: [
						{ id: "doc-b", score: 0.9, rank: 1 },
						{ id: "doc-a", score: 0.1, rank: 2 },
					],
				}),
				retrieveGraph: async (_ctx, request) => {
					seeds = request.documentSeeds;
					return [];
				},
			},
		);
		expect(seeds[0]).toBe("doc-b");
	});

	test("graph-after-rerank keeps graph evidence on documents already in the prefix", async () => {
		const response = await searchDocuments(
			ctx,
			{
				query: "English",
				limit: 10,
				rerankEnabled: true,
				rerankGraphPosition: "after",
			},
			{
				retrieveFast: async () =>
					channels({
						exact: [candidate("doc-a", "exact", 1)],
						fts: [candidate("doc-b", "fts", 1)],
					}),
				expand: async () => null,
				loadRerankTexts: async () =>
					new Map([
						["doc-a", "alpha"],
						["doc-b", "beta"],
					]),
				rerank: async () => ({
					model: "voyageai/rerank-2.5",
					hits: [
						{ id: "doc-a", score: 0.9, rank: 1 },
						{ id: "doc-b", score: 0.1, rank: 2 },
					],
				}),
				retrieveGraph: async () => [candidate("doc-b", "graph")],
			},
		);
		expect(response.diagnostics.graphContribution).toBe(true);
		expect(
			response.items.find((item) => item.documentId === "doc-b")?.channels,
		).toContain("graph");
		expect(response.items.map((item) => item.documentId)).toEqual([
			"doc-a",
			"doc-b",
		]);
	});
});
