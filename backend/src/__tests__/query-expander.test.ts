import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const redisGet = mock(async (_key: string) => null as string | null);
const redisSet = mock(async (..._args: unknown[]) => "OK");

mock.module("../lib/redis", () => ({
	redis: { get: redisGet, set: redisSet },
}));
mock.module("../lib/config", () => ({
	config: {
		SEARCH_EXPANSION_ENABLED: true,
		SEARCH_EXPANSION_BASE_URL: "https://openrouter.ai/api/v1",
		SEARCH_EXPANSION_MODEL: "mistralai/ministral-14b-2512",
		SEARCH_EXPANSION_FALLBACK_BASE_URL: "https://openrouter.ai/api/v1",
		SEARCH_EXPANSION_FALLBACK_MODEL: "google/gemma-4-31b-it",
		SEARCH_EXPANSION_TIMEOUT_MS: 2_000,
		SEARCH_EXPANSION_CACHE_TTL_SECONDS: 86_400,
		SEARCH_EXPANSION_MAX_VARIANTS: 12,
		OPENROUTER_API_KEY: "test-key",
	},
}));

const originalFetch = globalThis.fetch;

function queryPlan(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		original: "\u0430\u043d\u0433\u043b\u0438\u0439\u0441\u043a\u0438\u0439",
		normalized: "\u0430\u043d\u0433\u043b\u0438\u0439\u0441\u043a\u0438\u0439",
		detectedLanguage: "ru",
		translations: [],
		synonyms: [],
		concepts: [],
		namedEntities: [],
		...overrides,
	};
}

function completion(content: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("structured query expansion", () => {
	beforeEach(() => {
		redisGet.mockReset();
		redisGet.mockResolvedValue(null);
		redisSet.mockReset();
		redisSet.mockResolvedValue("OK");
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("expands Russian input to English and removes the original query", async () => {
		globalThis.fetch = mock(
			async () =>
				completion(
					JSON.stringify({
						translations: [
							"English",
							"\u0430\u043d\u0433\u043b\u0438\u0439\u0441\u043a\u0438\u0439",
						],
						synonyms: ["English language"],
						concepts: ["language settings"],
						namedEntities: [],
					}),
				) as unknown as Response,
		) as unknown as typeof fetch;

		const { expandQuery } = await import("../search/query-expander");
		const result = await expandQuery(queryPlan(), { tenantScope: "tenant-a" });
		expect(result?.plan.translations).toEqual(["English"]);
		expect(result?.plan.synonyms).toEqual(["English language"]);
		expect(result?.plan.concepts).toEqual(["language settings"]);
		expect(result?.model).toBe("mistralai/ministral-14b-2512");
	});

	test("removes both original and normalized query variants", async () => {
		globalThis.fetch = mock(
			async () =>
				completion(
					JSON.stringify({
						translations: [
							"English language",
							"English Language",
							"english language",
						],
						synonyms: ["English language"],
						concepts: [],
						namedEntities: [],
					}),
				) as unknown as Response,
		) as unknown as typeof fetch;

		const { expandQuery } = await import("../search/query-expander");
		const result = await expandQuery(
			queryPlan({
				original: "English Language",
				normalized: "english language",
			}),
			{ tenantScope: "tenant-a" },
		);
		expect(result?.plan.translations).toEqual([]);
		expect(result?.plan.synonyms).toEqual([]);
	});

	test("deduplicates and caps every variant list", async () => {
		globalThis.fetch = mock(
			async () =>
				completion(
					JSON.stringify({
						translations: Array.from({ length: 20 }, (_, i) =>
							i % 2 ? "EN" : "en",
						),
						synonyms: ["One", "one", "Two"],
						concepts: ["A", "B"],
						namedEntities: ["X", "x"],
					}),
				) as unknown as Response,
		) as unknown as typeof fetch;

		const { expandQuery } = await import("../search/query-expander");
		const result = await expandQuery(queryPlan(), { tenantScope: "tenant-a" });
		expect(result?.plan.translations).toEqual(["en"]);
		expect(result?.plan.synonyms).toEqual(["One", "Two"]);
		expect(result?.plan.namedEntities).toEqual(["X"]);
		for (const list of [
			result?.plan.translations,
			result?.plan.synonyms,
			result?.plan.concepts,
			result?.plan.namedEntities,
		]) {
			expect((list ?? []).length).toBeLessThanOrEqual(12);
		}
	});

	test("uses local fallback for malformed provider JSON", async () => {
		globalThis.fetch = mock(async () =>
			completion("not-json"),
		) as unknown as typeof fetch;
		const { expandQuery } = await import("../search/query-expander");
		const result = await expandQuery(queryPlan(), { tenantScope: "tenant-a" });
		expect(result?.model).toBe("local-lexicon-v1");
		expect(result?.plan.translations).toEqual(["english"]);
	});

	test("falls back after a primary timeout", async () => {
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls++;
			if (calls === 1) throw new DOMException("timed out", "AbortError");
			return completion(
				JSON.stringify({
					translations: ["English"],
					synonyms: [],
					concepts: [],
					namedEntities: [],
				}),
			);
		}) as unknown as typeof fetch;
		const { expandQuery } = await import("../search/query-expander");
		const result = await expandQuery(queryPlan(), { tenantScope: "tenant-a" });
		expect(result?.model).toBe("google/gemma-4-31b-it");
		expect(calls).toBe(2);
	});

	test("uses deterministic cross-language fallback when both providers fail", async () => {
		globalThis.fetch = mock(async () => {
			throw new Error("provider unavailable");
		}) as unknown as typeof fetch;
		const { expandQuery } = await import("../search/query-expander");
		const result = await expandQuery(queryPlan(), { tenantScope: "tenant-a" });
		expect(result?.model).toBe("local-lexicon-v1");
		expect(result?.plan.translations).toContain("english");
	});

	test("expands a broad language concept without provider availability", async () => {
		globalThis.fetch = mock(async () => {
			throw new Error("provider unavailable");
		}) as unknown as typeof fetch;
		const { expandQuery } = await import("../search/query-expander");
		const result = await expandQuery(
			queryPlan({ original: "разные языки", normalized: "разные языки" }),
			{ tenantScope: "tenant-a" },
		);
		expect(result?.plan.translations).toEqual(["language", "languages"]);
		expect(result?.plan.concepts).toEqual(
			expect.arrayContaining(["english", "french", "portuguese"]),
		);
	});

	test("uses tenant-scoped hashed cache keys without raw queries", async () => {
		globalThis.fetch = mock(
			async () =>
				completion(
					JSON.stringify({
						translations: ["English"],
						synonyms: [],
						concepts: [],
						namedEntities: [],
					}),
				) as unknown as Response,
		) as unknown as typeof fetch;
		const { expandQuery } = await import("../search/query-expander");
		await expandQuery(queryPlan(), { tenantScope: "tenant-a" });
		const keyA = String(redisSet.mock.calls[0]?.[0] ?? "");
		expect(keyA).toMatch(/^hiai-docs:search:expansion:[a-f0-9]{64}$/);
		expect(keyA).not.toContain(
			"\u0430\u043d\u0433\u043b\u0438\u0439\u0441\u043a\u0438\u0439",
		);
		redisSet.mockClear();
		await expandQuery(queryPlan(), { tenantScope: "tenant-b" });
		const keyB = String(redisSet.mock.calls[0]?.[0] ?? "");
		expect(keyB).not.toBe(keyA);
	});
});
