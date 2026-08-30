import { describe, expect, test } from "bun:test";
import {
	CANDIDATE_MODELS,
	CURRENT_CHAT_CHAIN,
	CURRENT_EMBED_CHAIN,
	modelsForSlot,
	SEARCH_RERANK_ENV,
	SPEED_TASKS,
	speedBakeOffIds,
} from "../lib/openrouter-candidate-matrix";
import {
	OPENROUTER_PUBLIC_CHAT_MODELS,
	OPENROUTER_PUBLIC_EMBEDDING_MODELS,
} from "../lib/openrouter-public-matrix";

const orchestrator = await Bun.file(
	new URL("../search/orchestrator.ts", import.meta.url),
).text();
const expander = await Bun.file(
	new URL("../search/query-expander.ts", import.meta.url),
).text();

describe("candidate slot assignment", () => {
	test("keeps the shipped embed and chat chains as the speed baseline", () => {
		expect(CURRENT_EMBED_CHAIN).toEqual([
			OPENROUTER_PUBLIC_EMBEDDING_MODELS.primary,
			OPENROUTER_PUBLIC_EMBEDDING_MODELS.fallback,
			OPENROUTER_PUBLIC_EMBEDDING_MODELS.fallback_2,
		]);
		expect(CURRENT_CHAT_CHAIN).toEqual([
			OPENROUTER_PUBLIC_CHAT_MODELS.primary,
			OPENROUTER_PUBLIC_CHAT_MODELS.fallback,
			OPENROUTER_PUBLIC_CHAT_MODELS.fallback_2,
		]);
	});

	test("does not put a reranker on embed, extract, or expansion", () => {
		for (const model of CANDIDATE_MODELS) {
			if (model.id.includes("rerank")) {
				expect(model.slot).toBe("rerank");
			}
		}
		expect(modelsForSlot("rerank").map((model) => model.id)).toEqual([
			"qwen/qwen3-reranker-0.6b",
			"qwen/qwen3-reranker-4b",
			"qwen/qwen3-reranker-8b",
			"nvidia/llama-nemotron-rerank-vl-1b-v2:free",
			"voyageai/rerank-2.5-lite",
			"voyageai/rerank-2.5",
		]);
	});

	test("voyage-multimodal is an embedder, not a writing model", () => {
		const voyage = CANDIDATE_MODELS.find(
			(model) => model.id === "voyageai/voyage-multimodal-3.5",
		);
		expect(voyage?.slot).toBe("not_for_this_stack");
		expect(voyage?.role).toBe("incompatible");
	});

	test("rejects the 2048-dim Nemotron embedder for the 1024 column", () => {
		const nemotron = CANDIDATE_MODELS.find(
			(model) => model.id === "nvidia/nemotron-3-embed-1b:free",
		);
		expect(nemotron?.dimFit).toBe("incompatible");
		expect(speedBakeOffIds().embed).not.toContain(nemotron?.id);
		expect(speedBakeOffIds().embed).toContain("voyageai/voyage-4-lite");
		expect(speedBakeOffIds().embed).toContain("google/gemini-embedding-2");
	});

	test("marks Qwen 0.6B and 4B as listed slugs with zero endpoints", () => {
		expect(
			CANDIDATE_MODELS.filter(
				(model) =>
					model.id === "qwen/qwen3-reranker-0.6b" ||
					model.id === "qwen/qwen3-reranker-4b",
			).every((model) => model.availability === "listed_no_endpoints"),
		).toBe(true);
		expect(speedBakeOffIds().rerank).toEqual([
			"qwen/qwen3-reranker-8b",
			"nvidia/llama-nemotron-rerank-vl-1b-v2:free",
			"voyageai/rerank-2.5-lite",
			"voyageai/rerank-2.5",
		]);
	});
});

describe("rerank is an optional fail-open step after RRF", () => {
	test("search still fuses with RRF and only reranks through the dedicated provider", () => {
		expect(orchestrator).toContain("fuseCandidates");
		expect(orchestrator).toContain("requestRerank");
		expect(orchestrator).toContain("SEARCH_RERANK_ENABLED");
		expect(expander).toContain("translations");
		expect(expander).toContain("synonyms");
		expect(expander).not.toContain("relevance_score");
	});

	test("documents the future rerank env surface and speed tasks", () => {
		expect(Object.values(SEARCH_RERANK_ENV)).toEqual([
			"SEARCH_RERANK_ENABLED",
			"SEARCH_RERANK_BASE_URL",
			"SEARCH_RERANK_API_KEY",
			"SEARCH_RERANK_MODEL",
			"SEARCH_RERANK_FALLBACK_MODEL",
			"SEARCH_RERANK_FALLBACK_2_MODEL",
			"SEARCH_RERANK_TIMEOUT_MS",
			"SEARCH_RERANK_TOP_N",
		]);
		expect(SPEED_TASKS).toEqual([
			"embed_query",
			"embed_chunk",
			"extract_entities",
			"expand_query",
			"summarize_document",
			"rerank_fused_hits",
		]);
	});
});
