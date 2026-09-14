import { afterEach, describe, expect, mock, test } from "bun:test";
import type { TenantContext } from "@hiai-docs/db/with-tenant";
import { hasSearchableActiveGeneration } from "../embedding/searchable-generation";
import { config } from "../lib/config";
import { envSchema } from "../lib/config-schema";
import { rankEvaluationQuery } from "../scripts/eval-retrieval";
import { evaluateOfflineBaseline } from "../search/eval/offline-eval";
import matrix from "../search/eval/retrieval-failure-matrix.json";
import { dcg, ndcgAt } from "../search/eval-metrics";
import { searchDocuments } from "../search/orchestrator";
import { requestRerank } from "../search/rerank-provider";
import type {
	ChannelResult,
	SearchCandidate,
	SearchChannel,
} from "../search/types";

const OWNER = "00000000-0000-4000-8000-000000000001";
const ctx: TenantContext = { userId: OWNER, role: "user" };
const originalFetch = globalThis.fetch;
const originalRerank = {
	baseUrl: config.SEARCH_RERANK_BASE_URL,
	model: config.SEARCH_RERANK_MODEL,
	fallbackUrl: config.SEARCH_RERANK_FALLBACK_BASE_URL,
	fallbackModel: config.SEARCH_RERANK_FALLBACK_MODEL,
	fallback2Url: config.SEARCH_RERANK_FALLBACK_2_BASE_URL,
	fallback2Model: config.SEARCH_RERANK_FALLBACK_2_MODEL,
};

afterEach(() => {
	globalThis.fetch = originalFetch;
	Object.assign(config, {
		SEARCH_RERANK_BASE_URL: originalRerank.baseUrl,
		SEARCH_RERANK_MODEL: originalRerank.model,
		SEARCH_RERANK_FALLBACK_BASE_URL: originalRerank.fallbackUrl,
		SEARCH_RERANK_FALLBACK_MODEL: originalRerank.fallbackModel,
		SEARCH_RERANK_FALLBACK_2_BASE_URL: originalRerank.fallback2Url,
		SEARCH_RERANK_FALLBACK_2_MODEL: originalRerank.fallback2Model,
	});
});

function candidate(
	documentId: string,
	channel: SearchChannel,
	rank = 1,
): SearchCandidate {
	return {
		documentId,
		channel,
		rank,
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

describe("retrieval failure and evaluation matrix", () => {
	test("evaluation keeps baseline provider-free and only calls a provider for live rerank", async () => {
		const documents = [
			{ id: "doc-a", title: "Alpha", text: "first" },
			{ id: "doc-b", title: "Beta", text: "second" },
		];
		let calls = 0;
		const rerank = async () => {
			calls++;
			return { model: "test", hits: [{ id: "doc-b", score: 1, rank: 1 }] };
		};
		const query = { id: "q", query: "Alpha", class: "test", labels: {} };
		for (const live of [false, true]) {
			expect(
				await rankEvaluationQuery(
					query,
					documents,
					{ mode: "baseline", live, topN: 20 },
					rerank,
				),
			).toEqual(["doc-a", "doc-b"]);
		}
		expect(calls).toBe(0);
		await rankEvaluationQuery(
			query,
			documents,
			{ mode: "rerank", live: false, topN: 20 },
			rerank,
		);
		expect(calls).toBe(0);
		expect(
			await rankEvaluationQuery(
				query,
				documents,
				{ mode: "rerank", live: true, topN: 20 },
				rerank,
			),
		).toEqual(["doc-b", "doc-a"]);
		expect(calls).toBe(1);
	});

	test("records graded nDCG from the canonical offline evaluator", () => {
		const labels = { a: 3, b: 2 };
		const actual = dcg([2, 3]);
		const ideal = dcg([3, 2]);
		expect(ndcgAt(["b", "a"], labels, 10)).toBe(actual / ideal);
		expect(ndcgAt(["a", "b"], labels, 10)).toBe(1);

		const evaluated = evaluateOfflineBaseline();
		const defaults = envSchema.parse({});
		expect(matrix.dataset.documentCount).toBe(evaluated.documents.length);
		expect(matrix.dataset.queryCount).toBe(evaluated.queries.length);
		expect(matrix.dataset.documentIds).toEqual(
			evaluated.documents.map((doc) => doc.id),
		);
		expect(new Set(evaluated.queries.map((query) => query.class))).toEqual(
			new Set(matrix.dataset.classes),
		);
		expect(matrix.configuration.SEARCH_RERANK_ENABLED).toBe(
			defaults.SEARCH_RERANK_ENABLED,
		);
		expect(matrix.configuration.SEARCH_RERANK_MODEL).toBe(
			defaults.SEARCH_RERANK_MODEL,
		);
		expect(matrix.configuration.SEARCH_RERANK_GRAPH_POSITION).toBe(
			defaults.SEARCH_RERANK_GRAPH_POSITION,
		);
		expect(matrix.configuration.GRAPH_SEARCH_ENABLED).toBe(
			defaults.GRAPH_SEARCH_ENABLED,
		);
		expect(matrix.configuration.SEARCH_RRF_K).toBe(defaults.SEARCH_RRF_K);
		expect(matrix.configuration.embeddingDimensions).toBe(1024);
		expect(matrix.configuration.algorithm).toBe("title-overlap-lexical");
		expect(matrix.metrics).toEqual(evaluated.summary);
		expect(matrix.rows).toEqual(evaluated.rows);
		expect(matrix.failureCases.map((item) => item.id)).toEqual([
			"last-ready-generation-searchable",
			"rerank-identity-empty-filter",
			"rerank-fail-open",
			"authorized-graph-contribution",
		]);
	});

	test("keeps the last ready generation searchable across pending replacements", () => {
		const ready = {
			activeGenerationId: "generation-a",
			candidateGenerationId: "generation-b",
			rowGenerationId: "generation-a",
			documentProfile: "model:1024:v1",
			rowProfile: "model:1024:v1",
			rowDimensions: 1024,
			rowValid: true,
		};
		expect(hasSearchableActiveGeneration(ready)).toBe(true);
		expect(
			hasSearchableActiveGeneration({
				...ready,
				rowGenerationId: "generation-b",
			}),
		).toBe(false);
		expect(
			hasSearchableActiveGeneration({
				...ready,
				rowValid: false,
			}),
		).toBe(false);
	});

	test("maps rerank provider indexes onto original IDs after empty-text filtering", async () => {
		Object.assign(config, {
			SEARCH_RERANK_BASE_URL: "https://primary.test/v1",
			SEARCH_RERANK_MODEL: "voyageai/rerank-2.5",
			SEARCH_RERANK_FALLBACK_BASE_URL: "",
			SEARCH_RERANK_FALLBACK_MODEL: "",
			SEARCH_RERANK_FALLBACK_2_BASE_URL: "",
			SEARCH_RERANK_FALLBACK_2_MODEL: "",
		});
		globalThis.fetch = mock(async () => {
			return new Response(
				JSON.stringify({
					results: [
						{ index: 1, relevance_score: 0.91 },
						{ index: 0, relevance_score: 0.42 },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		const result = await requestRerank({
			query: "q",
			candidates: [
				{ id: "empty", text: "  " },
				{ id: "doc-a", text: "alpha" },
				{ id: "doc-b", text: "beta" },
			],
		});
		expect(result?.hits.map((hit) => hit.id)).toEqual(["doc-b", "doc-a"]);
	});

	test("keeps RRF identities when rerank fails open", async () => {
		const response = await searchDocuments(
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
				rerank: async () => {
					throw new Error("rerank provider down");
				},
			},
		);
		expect(response.items.map((item) => item.documentId)).toEqual([
			"doc-a",
			"doc-b",
		]);
		expect(response.diagnostics.rerankFallback).toBe(true);
	});

	test("drops unauthorized graph neighbors and keeps authorized graph evidence", async () => {
		const response = await searchDocuments(
			ctx,
			{
				query: "English",
				limit: 10,
				rerankEnabled: true,
				rerankGraphPosition: "after",
				documentIds: ["doc-a", "doc-b"],
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
				retrieveGraph: async () => [
					candidate("doc-b", "graph"),
					candidate("secret", "graph"),
				],
			},
		);
		expect(response.items.map((item) => item.documentId)).toEqual([
			"doc-a",
			"doc-b",
		]);
		expect(
			response.items.find((item) => item.documentId === "doc-b")?.channels,
		).toContain("graph");
		expect(response.diagnostics.graphContribution).toBe(true);
		expect(response.items.some((item) => item.documentId === "secret")).toBe(
			false,
		);
	});
});
