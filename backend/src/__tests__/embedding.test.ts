import { afterEach, describe, expect, test } from "bun:test";

import { config } from "../lib/config";

const originalFetch = globalThis.fetch;
const originalEmbeddingConfig = {
	baseUrl: config.EMBEDDING_BASE_URL,
	apiKey: config.EMBEDDING_API_KEY,
	model: config.EMBEDDING_MODEL,
	fallbackBaseUrl: config.EMBEDDING_FALLBACK_BASE_URL,
	fallbackApiKey: config.EMBEDDING_FALLBACK_API_KEY,
	fallbackModel: config.EMBEDDING_FALLBACK_MODEL,
};

afterEach(() => {
	globalThis.fetch = originalFetch;
	Object.assign(config, {
		EMBEDDING_BASE_URL: originalEmbeddingConfig.baseUrl,
		EMBEDDING_API_KEY: originalEmbeddingConfig.apiKey,
		EMBEDDING_MODEL: originalEmbeddingConfig.model,
		EMBEDDING_FALLBACK_BASE_URL: originalEmbeddingConfig.fallbackBaseUrl,
		EMBEDDING_FALLBACK_API_KEY: originalEmbeddingConfig.fallbackApiKey,
		EMBEDDING_FALLBACK_MODEL: originalEmbeddingConfig.fallbackModel,
	});
});

function configureEmbeddingProviders(options: {
	primary?: boolean;
	fallback?: boolean;
}) {
	Object.assign(config, {
		EMBEDDING_BASE_URL: options.primary ? "https://primary.test/v1" : undefined,
		EMBEDDING_API_KEY: "test-key",
		EMBEDDING_MODEL: options.primary ? "primary-model" : undefined,
		EMBEDDING_FALLBACK_BASE_URL: options.fallback
			? "https://fallback.test/v1"
			: undefined,
		EMBEDDING_FALLBACK_API_KEY: "fallback-key",
		EMBEDDING_FALLBACK_MODEL: options.fallback ? "fallback-model" : undefined,
	});
}

function vector(value: number): number[] {
	return Array.from({ length: 1024 }, () => value);
}

function responseFor(embedding: number[], status = 200): Response {
	return new Response(JSON.stringify({ data: [{ embedding }] }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("embedding providers", () => {
	test("getEmbedding returns an explicit result when unavailable", async () => {
		configureEmbeddingProviders({});
		const mod = await import("../embedding/index");
		const result = await mod.getEmbedding("test text");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("not_configured");
	});

	test("returns a validated primary result with its profile", async () => {
		configureEmbeddingProviders({ primary: true });
		globalThis.fetch = (async () =>
			responseFor(vector(0.1))) as unknown as typeof fetch;

		const { getEmbedding } = await import("../embedding/index");
		const result = await getEmbedding("primary text");

		expect(result).toMatchObject({
			ok: true,
			model: "primary-model",
			provider: "primary",
			dimensions: 1024,
			profile: "primary-model:1024:v1",
		});
	});

	test("falls back when the primary provider fails", async () => {
		configureEmbeddingProviders({ primary: true, fallback: true });
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			return String(input).includes("primary.test")
				? responseFor([], 503)
				: responseFor(vector(0.2));
		}) as unknown as typeof fetch;

		const { getEmbedding } = await import("../embedding/index");
		const result = await getEmbedding("fallback text");

		expect(result).toMatchObject({
			ok: true,
			model: "fallback-model",
			provider: "fallback",
		});
	});

	test("falls back when the primary vector is invalid", async () => {
		configureEmbeddingProviders({ primary: true, fallback: true });
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			return String(input).includes("primary.test")
				? responseFor(vector(0))
				: responseFor(vector(0.3));
		}) as unknown as typeof fetch;

		const { getEmbedding } = await import("../embedding/index");
		const result = await getEmbedding("invalid primary");

		expect(result).toMatchObject({ ok: true, provider: "fallback" });
	});

	test("returns a safe failure when both providers return invalid vectors", async () => {
		configureEmbeddingProviders({ primary: true, fallback: true });
		globalThis.fetch = (async () =>
			responseFor(vector(0))) as unknown as typeof fetch;

		const { getEmbedding } = await import("../embedding/index");
		const result = await getEmbedding("invalid providers");

		expect(result).toMatchObject({
			ok: false,
			code: "zero_vector",
			primaryError: "provider returned zero_vector",
			fallbackError: "provider returned zero_vector",
		});
	});

	test("embedDocument returns array of 1024-dim vectors", async () => {
		configureEmbeddingProviders({ primary: true });
		globalThis.fetch = (async () =>
			responseFor(vector(0.1))) as unknown as typeof fetch;
		const mod = await import("../embedding/index");
		const result = await mod.embedDocument(
			"Test Title",
			"Short content for test.",
		);
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBeGreaterThanOrEqual(1);
		if (result[0]) {
			expect(result[0].embedding.length).toBe(1024);
			expect(result[0].dimensions).toBe(1024);
			expect(result[0].model.length).toBeGreaterThan(0);
			expect(result[0].profile).toContain(":1024:");
		}
	});

	test("normalizeDimensions utility works correctly", async () => {
		const mod = await import("../embedding/utils");
		// Test with vector shorter than target
		const short = mod.normalizeDimensions([1, 2, 3], 5);
		expect(short).toEqual([1, 2, 3, 0, 0]);

		// Test with vector longer than target
		const long = mod.normalizeDimensions([1, 2, 3, 4, 5], 3);
		expect(long).toEqual([1, 2, 3]);

		// Test with exact length
		const exact = mod.normalizeDimensions([1, 2, 3], 3);
		expect(exact).toEqual([1, 2, 3]);
	});
});
