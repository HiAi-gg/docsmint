import { describe, expect, test } from "bun:test";
import {
	OPENROUTER_PUBLIC_EMBEDDING_MODELS,
	OPENROUTER_PUBLIC_EXPANSION_MODELS,
	OPENROUTER_PUBLIC_EXTRACT_MODELS,
	OPENROUTER_PUBLIC_RERANK_MODELS,
} from "../lib/openrouter-public-matrix";

const root = new URL("../../../", import.meta.url);

async function readRepoFile(relativePath: string): Promise<string> {
	return Bun.file(new URL(relativePath, root)).text();
}

describe("OpenRouter public matrix: primary plus two fallbacks", () => {
	test("pins embeddings, extract, expansion, and rerank chains", () => {
		expect(OPENROUTER_PUBLIC_EMBEDDING_MODELS).toEqual({
			primary: "voyageai/voyage-4-lite",
			fallback: "baai/bge-m3",
			fallback_2: "openai/text-embedding-3-small",
		});
		expect(OPENROUTER_PUBLIC_EXTRACT_MODELS).toEqual({
			primary: "nvidia/nemotron-3.5-lightning",
			fallback: "mistralai/mistral-small-2603",
			fallback_2: "google/gemma-4-31b-it",
		});
		expect(OPENROUTER_PUBLIC_EXPANSION_MODELS).toEqual({
			primary: "poolside/laguna-xs-2.1",
			fallback: "openai/gpt-5.6-luna",
			fallback_2: "google/gemini-3.5-flash-lite",
		});
		expect(OPENROUTER_PUBLIC_RERANK_MODELS).toEqual({
			primary: "voyageai/rerank-2.5",
			fallback: "cohere/rerank-v3.5",
			fallback_2: "nvidia/llama-nemotron-rerank-vl-1b-v2:free",
		});
	});

	test("pins the matrix in the committed operator templates", async () => {
		const sources = await Promise.all([
			readRepoFile(".env.example"),
			readRepoFile("docker-compose.yml"),
			readRepoFile("docker-compose.dev.yml.example"),
		]);
		for (const source of sources) {
			expect(source).toContain(OPENROUTER_PUBLIC_EMBEDDING_MODELS.primary);
			expect(source).toContain(OPENROUTER_PUBLIC_EMBEDDING_MODELS.fallback);
			expect(source).toContain(OPENROUTER_PUBLIC_EMBEDDING_MODELS.fallback_2);
			expect(source).toContain(OPENROUTER_PUBLIC_EXTRACT_MODELS.primary);
			expect(source).toContain(OPENROUTER_PUBLIC_EXTRACT_MODELS.fallback);
			expect(source).toContain(OPENROUTER_PUBLIC_EXTRACT_MODELS.fallback_2);
			expect(source).toContain("EMBEDDING_FALLBACK_2_MODEL");
			expect(source).toContain("GRAPH_EXTRACT_FALLBACK_2_MODEL");
		}
		expect(sources[0]).toContain(OPENROUTER_PUBLIC_EXPANSION_MODELS.primary);
		expect(sources[0]).toContain(OPENROUTER_PUBLIC_EXPANSION_MODELS.fallback);
		expect(sources[0]).toContain(OPENROUTER_PUBLIC_EXPANSION_MODELS.fallback_2);
		expect(sources[0]).toContain(OPENROUTER_PUBLIC_RERANK_MODELS.primary);
		expect(sources[0]).toContain(OPENROUTER_PUBLIC_RERANK_MODELS.fallback);
		expect(sources[0]).toContain(OPENROUTER_PUBLIC_RERANK_MODELS.fallback_2);
		expect(sources[1]).toContain(OPENROUTER_PUBLIC_EXPANSION_MODELS.primary);
		expect(sources[1]).toContain(OPENROUTER_PUBLIC_RERANK_MODELS.primary);
	});
});
