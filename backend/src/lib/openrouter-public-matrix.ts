/**
 * Public OpenRouter search profile: one primary plus two fallbacks per job.
 * Embeddings must remain 1024-dimensional (native or via `dimensions`).
 * Extract and expansion send `response_format: json_object` when the
 * provider advertises it; Laguna still returned valid JSON without it.
 */
export const OPENROUTER_PUBLIC_BASE_URL = "https://openrouter.ai/api/v1";

export const OPENROUTER_PUBLIC_EMBEDDING_MODELS = {
	primary: "voyageai/voyage-4-lite",
	fallback: "baai/bge-m3",
	fallback_2: "openai/text-embedding-3-small",
} as const;

export const OPENROUTER_PUBLIC_EXTRACT_MODELS = {
	primary: "nvidia/nemotron-3.5-lightning",
	fallback: "mistralai/mistral-small-2603",
	fallback_2: "google/gemma-4-31b-it",
} as const;

export const OPENROUTER_PUBLIC_EXPANSION_MODELS = {
	primary: "poolside/laguna-xs-2.1",
	fallback: "openai/gpt-5.6-luna",
	fallback_2: "google/gemini-3.5-flash-lite",
} as const;

export const OPENROUTER_PUBLIC_RERANK_MODELS = {
	primary: "voyageai/rerank-2.5",
	fallback: "cohere/rerank-v3.5",
	fallback_2: "nvidia/llama-nemotron-rerank-vl-1b-v2:free",
} as const;

/** @deprecated Use EXTRACT or EXPANSION; kept as the extract chain alias. */
export const OPENROUTER_PUBLIC_CHAT_MODELS = OPENROUTER_PUBLIC_EXTRACT_MODELS;
