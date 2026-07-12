import { describe, expect, mock, test } from "bun:test";
import type { TenantContext } from "@hiai-docs/db/with-tenant";
import type { EmbeddingResult } from "../embedding/result";
import { getMetrics, METRIC_NAMES, resetMetrics } from "../lib/metrics";
import {
	folderCategoryMatchesOwner,
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
	test("does not apply a folder category from another owner", () => {
		expect(
			folderCategoryMatchesOwner(
				{
					folderCategoryId: "category-1",
					folderOwnerId: "another-owner",
				},
				"category-1",
				OWNER,
			),
		).toBe(false);
		expect(
			folderCategoryMatchesOwner(
				{ folderCategoryId: "category-1", folderOwnerId: OWNER },
				"category-1",
				OWNER,
			),
		).toBe(true);
	});

	test("shares one request embedding with vector retrieval and hydration", async () => {
		const provider = mock(async () => queryEmbedding);
		let requestEmbedding: EmbeddingResult | undefined;
		const response = await searchDocuments(
			ctx,
			{ query: "English", limit: 10 },
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
			{ query: "English", limit: 10 },
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
			{ query: "English", limit: 10 },
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
			{ query: "английский", limit: 10 },
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
			{ query: "разные языки", limit: 10 },
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
			{ query: "topic" },
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

	test("counts graph contribution only when a graph candidate reaches final items", async () => {
		resetMetrics();
		await searchDocuments(
			ctx,
			{ query: "topic", page: 2, limit: 1 },
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
			{ query: "Exact title" },
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
			{ query: "таймаут" },
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
			{ query: "direct" },
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
			{ query: "missing" },
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
			{ query: "scope" },
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
			{ query: "русский термин" },
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
