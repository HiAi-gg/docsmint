import { afterEach, describe, expect, mock, test } from "bun:test";
import { config } from "../lib/config";
import { getMetrics, METRIC_NAMES, resetMetrics } from "../lib/metrics";
import { requestRerank } from "../search/rerank-provider";

const originalFetch = globalThis.fetch;
const original = {
	enabled: config.SEARCH_RERANK_ENABLED,
	baseUrl: config.SEARCH_RERANK_BASE_URL,
	model: config.SEARCH_RERANK_MODEL,
	fallbackUrl: config.SEARCH_RERANK_FALLBACK_BASE_URL,
	fallbackModel: config.SEARCH_RERANK_FALLBACK_MODEL,
	fallback2Url: config.SEARCH_RERANK_FALLBACK_2_BASE_URL,
	fallback2Model: config.SEARCH_RERANK_FALLBACK_2_MODEL,
	timeout: config.SEARCH_RERANK_TIMEOUT_MS,
};

afterEach(() => {
	globalThis.fetch = originalFetch;
	Object.assign(config, {
		SEARCH_RERANK_ENABLED: original.enabled,
		SEARCH_RERANK_BASE_URL: original.baseUrl,
		SEARCH_RERANK_MODEL: original.model,
		SEARCH_RERANK_FALLBACK_BASE_URL: original.fallbackUrl,
		SEARCH_RERANK_FALLBACK_MODEL: original.fallbackModel,
		SEARCH_RERANK_FALLBACK_2_BASE_URL: original.fallback2Url,
		SEARCH_RERANK_FALLBACK_2_MODEL: original.fallback2Model,
		SEARCH_RERANK_TIMEOUT_MS: original.timeout,
	});
	resetMetrics();
});

describe("OpenRouter rerank provider", () => {
	function configurePrimary() {
		Object.assign(config, {
			SEARCH_RERANK_BASE_URL: "https://primary.test/v1",
			SEARCH_RERANK_MODEL: "voyageai/rerank-2.5",
			SEARCH_RERANK_FALLBACK_BASE_URL: "",
			SEARCH_RERANK_FALLBACK_MODEL: "",
			SEARCH_RERANK_FALLBACK_2_BASE_URL: "",
			SEARCH_RERANK_FALLBACK_2_MODEL: "",
		});
	}

	test("maps provider indexes onto candidate ids", async () => {
		Object.assign(config, {
			SEARCH_RERANK_BASE_URL: "https://primary.test/v1",
			SEARCH_RERANK_MODEL: "voyageai/rerank-2.5",
			SEARCH_RERANK_FALLBACK_BASE_URL: "",
			SEARCH_RERANK_FALLBACK_MODEL: "",
			SEARCH_RERANK_FALLBACK_2_BASE_URL: "",
			SEARCH_RERANK_FALLBACK_2_MODEL: "",
		});
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						results: [
							{ index: 1, relevance_score: 0.9 },
							{ index: 0, relevance_score: 0.1 },
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;
		const result = await requestRerank({
			query: "english",
			candidates: [
				{ id: "doc-a", text: "alpha" },
				{ id: "doc-b", text: "beta" },
			],
		});
		expect(result?.model).toBe("voyageai/rerank-2.5");
		expect(result?.hits.map((hit) => hit.id)).toEqual(["doc-b", "doc-a"]);
	});

	test("falls through to the next slot after a provider error", async () => {
		Object.assign(config, {
			SEARCH_RERANK_BASE_URL: "https://primary.test/v1",
			SEARCH_RERANK_MODEL: "voyageai/rerank-2.5",
			SEARCH_RERANK_FALLBACK_BASE_URL: "https://fallback.test/v1",
			SEARCH_RERANK_FALLBACK_MODEL: "cohere/rerank-v3.5",
			SEARCH_RERANK_FALLBACK_2_BASE_URL: "",
			SEARCH_RERANK_FALLBACK_2_MODEL: "",
		});
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls++;
			if (calls === 1) return new Response("no", { status: 503 });
			return new Response(
				JSON.stringify({
					results: [{ index: 0, relevance_score: 0.7 }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		const result = await requestRerank({
			query: "q",
			candidates: [{ id: "doc-1", text: "body" }],
		});
		expect(calls).toBe(2);
		expect(result?.model).toBe("cohere/rerank-v3.5");
	});

	test("returns null so search can keep RRF order", async () => {
		Object.assign(config, {
			SEARCH_RERANK_BASE_URL: "https://primary.test/v1",
			SEARCH_RERANK_MODEL: "voyageai/rerank-2.5",
			SEARCH_RERANK_FALLBACK_BASE_URL: "",
			SEARCH_RERANK_FALLBACK_MODEL: "",
			SEARCH_RERANK_FALLBACK_2_BASE_URL: "",
			SEARCH_RERANK_FALLBACK_2_MODEL: "",
		});
		globalThis.fetch = mock(async () => {
			throw new Error("down");
		}) as unknown as typeof fetch;
		expect(
			await requestRerank({
				query: "q",
				candidates: [{ id: "doc-1", text: "body" }],
			}),
		).toBeNull();
		expect(getMetrics()[METRIC_NAMES.SEARCH_RERANK_FALLBACK_TOTAL]).toBe(1);
	});

	test.each([
		{
			name: "first",
			candidates: [
				{ id: "empty", text: "  " },
				{ id: "doc-a", text: "alpha" },
				{ id: "doc-b", text: "beta" },
			],
		},
		{
			name: "middle",
			candidates: [
				{ id: "doc-a", text: "alpha" },
				{ id: "empty", text: "\n\t" },
				{ id: "doc-b", text: "beta" },
			],
		},
		{
			name: "multiple positions",
			candidates: [
				{ id: "empty-a", text: "" },
				{ id: "doc-a", text: "alpha" },
				{ id: "empty-b", text: "  " },
				{ id: "doc-b", text: "beta" },
				{ id: "empty-c", text: "\n" },
			],
		},
	])("keeps IDs aligned when empty candidates occur $name", async ({ candidates }) => {
		configurePrimary();
		let requestBody: { documents?: string[] } = {};
		globalThis.fetch = mock(async (_url, init) => {
			requestBody = JSON.parse(String(init?.body));
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

		const result = await requestRerank({ query: "q", candidates: [...candidates] });

		expect(requestBody.documents).toEqual(["alpha", "beta"]);
		expect(result?.hits).toEqual([
			{ id: "doc-b", score: 0.91, rank: 1 },
			{ id: "doc-a", score: 0.42, rank: 2 },
		]);
	});

	test("does not call a provider when every candidate is empty", async () => {
		configurePrimary();
		const provider = mock(async () => new Response("unexpected"));
		globalThis.fetch = provider as unknown as typeof fetch;

		expect(
			await requestRerank({
				query: "q",
				candidates: [
					{ id: "empty-a", text: "" },
					{ id: "empty-b", text: " \n\t" },
				],
			}),
		).toBeNull();
		expect(provider).not.toHaveBeenCalled();
	});

	test("keeps a partial response attached to the filtered document ID", async () => {
		configurePrimary();
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						results: [{ index: 1, relevance_score: 0.75 }],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;

		const result = await requestRerank({
			query: "q",
			candidates: [
				{ id: "empty", text: "" },
				{ id: "doc-a", text: "alpha" },
				{ id: "doc-b", text: "beta" },
				{ id: "doc-c", text: "gamma" },
			],
		});
		expect(result?.hits).toEqual([{ id: "doc-b", score: 0.75, rank: 1 }]);
	});

	test("ignores invalid indexes and duplicate provider hits", async () => {
		configurePrimary();
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						results: [
							{ index: 7, relevance_score: 1 },
							{ index: -1, relevance_score: 0.99 },
							{ index: 0.5, relevance_score: 0.98 },
							{ index: 1, relevance_score: 0.8 },
							{ index: 1, relevance_score: 0.7 },
							{ index: 2, relevance_score: 0.6 },
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;

		const result = await requestRerank({
			query: "q",
			candidates: [
				{ id: "empty", text: "" },
				{ id: "doc-a", text: "alpha" },
				{ id: "doc-b", text: "beta" },
				{ id: "doc-b", text: "beta duplicate" },
			],
		});
		expect(result?.hits).toEqual([
			{ id: "doc-b", score: 0.8, rank: 4 },
		]);
	});
});
