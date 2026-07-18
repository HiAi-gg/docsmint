import { describe, expect, test } from "bun:test";
import {
	graphBenchmarkHeaders,
	resolveGraphBenchmarkApiKey,
	retryAfterDelayMs,
} from "../scripts/benchmark-graph";

describe("GraphRAG speed benchmark transport", () => {
	test("uses the admin-only RAG profile only for the no-graph control run", () => {
		const ragOnly = graphBenchmarkHeaders("test-key", "rag-only");
		const graph = graphBenchmarkHeaders("test-key", "graphrag");

		expect(ragOnly).toEqual({
			Authorization: "Bearer test-key",
			Accept: "application/json",
			"X-Docsmint-Search-Profile": "rag-only",
		});
		expect(graph).toEqual({
			Authorization: "Bearer test-key",
			Accept: "application/json",
		});
	});

	test("reads the local admin key from environment without exposing it in arguments", () => {
		expect(
			resolveGraphBenchmarkApiKey({ HIAI_DOCS_API_KEY: "local-admin-key" }),
		).toBe("local-admin-key");
		expect(
			resolveGraphBenchmarkApiKey({ BENCHMARK_API_KEY: "fallback-key" }),
		).toBe("fallback-key");
		expect(resolveGraphBenchmarkApiKey({})).toBeNull();
	});

	test("waits for the server rate-limit window without counting wait time as search latency", () => {
		expect(retryAfterDelayMs("2")).toBe(2_000);
		expect(retryAfterDelayMs("0")).toBe(1_000);
		expect(retryAfterDelayMs("invalid")).toBe(1_000);
	});
});
