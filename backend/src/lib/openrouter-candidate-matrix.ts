import {
	OPENROUTER_PUBLIC_CHAT_MODELS,
	OPENROUTER_PUBLIC_EMBEDDING_MODELS,
} from "./openrouter-public-matrix";

/**
 * Candidate OpenRouter models for the search/embed/extract jobs. This is the
 * bake-off catalog, not the shipped public profile.
 *
 * Ranking today is RRF across exact/FTS/fuzzy/vector/expanded/graph. There is
 * no cross-encoder rerank step. Query expansion rewrites the query; it does
 * not score documents.
 */
export type MatrixSlot =
	| "embed"
	| "chat_extract"
	| "chat_expand"
	| "chat_summary"
	| "rerank"
	| "not_for_this_stack";

export type DimFit = "native_1024" | "request_1024" | "incompatible" | "n/a";

export type JsonFit = "structured" | "json_object" | "plain" | "n/a";

export type ReasoningRisk = "none" | "optional" | "mandatory" | "n/a";

export type OpenRouterAvailability =
	| "listed"
	| "listed_embeddings"
	| "listed_rerank"
	| "listed_no_endpoints"
	| "not_listed";

export interface CandidateModel {
	id: string;
	slot: MatrixSlot;
	role: "current" | "candidate" | "incompatible" | "unavailable";
	availability: OpenRouterAvailability;
	dimFit: DimFit;
	jsonFit: JsonFit;
	reasoning: ReasoningRisk;
	/** Prompt USD per million tokens when OpenRouter publishes a price. */
	promptUsdPerMillion?: number;
	notes: string;
}

export const SEARCH_RERANK_ENV = {
	ENABLED: "SEARCH_RERANK_ENABLED",
	BASE_URL: "SEARCH_RERANK_BASE_URL",
	API_KEY: "SEARCH_RERANK_API_KEY",
	MODEL: "SEARCH_RERANK_MODEL",
	FALLBACK_MODEL: "SEARCH_RERANK_FALLBACK_MODEL",
	FALLBACK_2_MODEL: "SEARCH_RERANK_FALLBACK_2_MODEL",
	TIMEOUT_MS: "SEARCH_RERANK_TIMEOUT_MS",
	TOP_N: "SEARCH_RERANK_TOP_N",
} as const;

export const SPEED_TASKS = [
	"embed_query",
	"embed_chunk",
	"extract_entities",
	"expand_query",
	"summarize_document",
	"rerank_fused_hits",
] as const;

export const CURRENT_EMBED_CHAIN = [
	OPENROUTER_PUBLIC_EMBEDDING_MODELS.primary,
	OPENROUTER_PUBLIC_EMBEDDING_MODELS.fallback,
	OPENROUTER_PUBLIC_EMBEDDING_MODELS.fallback_2,
] as const;

export const CURRENT_CHAT_CHAIN = [
	OPENROUTER_PUBLIC_CHAT_MODELS.primary,
	OPENROUTER_PUBLIC_CHAT_MODELS.fallback,
	OPENROUTER_PUBLIC_CHAT_MODELS.fallback_2,
] as const;

export const CANDIDATE_MODELS: readonly CandidateModel[] = [
	{
		id: OPENROUTER_PUBLIC_EMBEDDING_MODELS.primary,
		slot: "embed",
		role: "current",
		availability: "listed_embeddings",
		dimFit: "request_1024",
		jsonFit: "n/a",
		reasoning: "n/a",
		promptUsdPerMillion: 0.02,
		notes: "Current embed primary. Native 1536, we request 1024.",
	},
	{
		id: OPENROUTER_PUBLIC_EMBEDDING_MODELS.fallback,
		slot: "embed",
		role: "current",
		availability: "listed_embeddings",
		dimFit: "native_1024",
		jsonFit: "n/a",
		reasoning: "n/a",
		promptUsdPerMillion: 0.01,
		notes: "Current embed fallback. Native 1024, multilingual.",
	},
	{
		id: OPENROUTER_PUBLIC_EMBEDDING_MODELS.fallback_2,
		slot: "embed",
		role: "current",
		availability: "listed_embeddings",
		dimFit: "request_1024",
		jsonFit: "n/a",
		reasoning: "n/a",
		promptUsdPerMillion: 0.13,
		notes: "Current embed fallback_2. Native 3072, we request 1024.",
	},
	{
		id: "voyageai/voyage-4-lite",
		slot: "embed",
		role: "candidate",
		availability: "listed_embeddings",
		dimFit: "native_1024",
		jsonFit: "n/a",
		reasoning: "n/a",
		promptUsdPerMillion: 0.02,
		notes: "Best embed replacement: 1024 default, 32k context, ~0.18s p50.",
	},
	{
		id: "google/gemini-embedding-2",
		slot: "embed",
		role: "candidate",
		availability: "listed_embeddings",
		dimFit: "request_1024",
		jsonFit: "n/a",
		reasoning: "n/a",
		promptUsdPerMillion: 0.2,
		notes:
			"Allows 128-3072; recommended 768/1536/3072. Probe 1024 before shipping.",
	},
	{
		id: "nvidia/nemotron-3-embed-1b:free",
		slot: "embed",
		role: "incompatible",
		availability: "listed_embeddings",
		dimFit: "incompatible",
		jsonFit: "n/a",
		reasoning: "n/a",
		promptUsdPerMillion: 0,
		notes:
			"Native 2048 and no reduced dimensions. Cannot fill the 1024 column.",
	},
	{
		id: "voyageai/voyage-multimodal-3.5",
		slot: "not_for_this_stack",
		role: "incompatible",
		availability: "listed_embeddings",
		dimFit: "request_1024",
		jsonFit: "n/a",
		reasoning: "n/a",
		promptUsdPerMillion: 0.12,
		notes:
			"Embedding-only (text, image, text+image at 1024). Chat extract/expand and /rerank are rejected. Useful later for screenshot/PDF page vectors, not writers.",
	},
	{
		id: OPENROUTER_PUBLIC_CHAT_MODELS.primary,
		slot: "chat_extract",
		role: "current",
		availability: "listed",
		dimFit: "n/a",
		jsonFit: "structured",
		reasoning: "none",
		promptUsdPerMillion: 0.2,
		notes: "Current extract/expand/summary primary.",
	},
	{
		id: OPENROUTER_PUBLIC_CHAT_MODELS.fallback,
		slot: "chat_extract",
		role: "current",
		availability: "listed",
		dimFit: "n/a",
		jsonFit: "structured",
		reasoning: "optional",
		promptUsdPerMillion: 0.09,
		notes: "Current chat fallback.",
	},
	{
		id: OPENROUTER_PUBLIC_CHAT_MODELS.fallback_2,
		slot: "chat_extract",
		role: "current",
		availability: "listed",
		dimFit: "n/a",
		jsonFit: "structured",
		reasoning: "none",
		promptUsdPerMillion: 0.71,
		notes:
			"Current chat fallback_2. Slowest/most expensive of the shipped chain.",
	},
	{
		id: "mistralai/mistral-small-2603",
		slot: "chat_extract",
		role: "candidate",
		availability: "listed",
		dimFit: "n/a",
		jsonFit: "structured",
		reasoning: "optional",
		promptUsdPerMillion: 0.15,
		notes: "JSON-capable successor to Ministral. First chat bake-off pick.",
	},
	{
		id: "qwen/qwen3.8-flash",
		slot: "chat_expand",
		role: "candidate",
		availability: "listed",
		dimFit: "n/a",
		jsonFit: "structured",
		reasoning: "optional",
		promptUsdPerMillion: 0.15,
		notes: "Fast JSON chat. Expansion and extract fallback.",
	},
	{
		id: "deepseek/deepseek-v4-flash-0731",
		slot: "chat_expand",
		role: "candidate",
		availability: "listed",
		dimFit: "n/a",
		jsonFit: "structured",
		reasoning: "optional",
		promptUsdPerMillion: 0.065,
		notes: "Cheap JSON. Expansion timeout is 6s; keep reasoning off.",
	},
	{
		id: "nvidia/nemotron-3.5-lightning",
		slot: "chat_expand",
		role: "candidate",
		availability: "listed",
		dimFit: "n/a",
		jsonFit: "structured",
		reasoning: "optional",
		promptUsdPerMillion: 0.08,
		notes: "High-throughput JSON. Strong expansion/extract speed candidate.",
	},
	{
		id: "tencent/hy3",
		slot: "chat_extract",
		role: "candidate",
		availability: "listed",
		dimFit: "n/a",
		jsonFit: "structured",
		reasoning: "optional",
		promptUsdPerMillion: 0.0825,
		notes: "JSON chat with optional reasoning=none.",
	},
	{
		id: "inclusionai/ling-3.0-flash",
		slot: "chat_expand",
		role: "candidate",
		availability: "listed",
		dimFit: "n/a",
		jsonFit: "json_object",
		reasoning: "optional",
		promptUsdPerMillion: 0.021,
		notes: "Cheapest listed chat. JSON object yes, structured_outputs no.",
	},
	{
		id: "minimax/minimax-m3",
		slot: "chat_summary",
		role: "candidate",
		availability: "listed",
		dimFit: "n/a",
		jsonFit: "structured",
		reasoning: "optional",
		promptUsdPerMillion: 0.3,
		notes: "JSON chat. Heavier than expansion budget prefers.",
	},
	{
		id: "openai/gpt-5.6-luna",
		slot: "chat_summary",
		role: "candidate",
		availability: "listed",
		dimFit: "n/a",
		jsonFit: "structured",
		reasoning: "optional",
		promptUsdPerMillion: 0.2,
		notes: "JSON chat. Better as summary/extract fallback than 6s expansion.",
	},
	{
		id: "google/gemini-3.5-flash-lite",
		slot: "chat_summary",
		role: "candidate",
		availability: "listed",
		dimFit: "n/a",
		jsonFit: "structured",
		reasoning: "mandatory",
		promptUsdPerMillion: 0.3,
		notes:
			"JSON yes, but reasoning is mandatory. Use effort=minimal if probed.",
	},
	{
		id: "z-ai/glm-5.3-flash",
		slot: "chat_summary",
		role: "candidate",
		availability: "listed",
		dimFit: "n/a",
		jsonFit: "structured",
		reasoning: "mandatory",
		promptUsdPerMillion: 0.075,
		notes: "Mandatory reasoning defaults to max. Poor fit for 6s expansion.",
	},
	{
		id: "meta/muse-glimmer-30b",
		slot: "chat_summary",
		role: "candidate",
		availability: "listed",
		dimFit: "n/a",
		jsonFit: "structured",
		reasoning: "mandatory",
		promptUsdPerMillion: 0.3,
		notes: "Mandatory reasoning. Skip for expansion.",
	},
	{
		id: "meta/muse-spark-1.2-contributor",
		slot: "chat_summary",
		role: "candidate",
		availability: "listed",
		dimFit: "n/a",
		jsonFit: "structured",
		reasoning: "mandatory",
		promptUsdPerMillion: 0.1,
		notes: "Mandatory reasoning. Skip for expansion.",
	},
	{
		id: "poolside/laguna-xs-2.1",
		slot: "chat_expand",
		role: "candidate",
		availability: "listed",
		dimFit: "n/a",
		jsonFit: "plain",
		reasoning: "optional",
		promptUsdPerMillion: 0.06,
		notes: "No response_format. Probe only if JSON still comes back.",
	},
	{
		id: "poolside/laguna-s-2.1",
		slot: "chat_extract",
		role: "candidate",
		availability: "listed",
		dimFit: "n/a",
		jsonFit: "plain",
		reasoning: "optional",
		promptUsdPerMillion: 0.09,
		notes: "No response_format. Same JSON risk as Laguna XS.",
	},
	{
		id: "qwen/qwen3-reranker-0.6b",
		slot: "rerank",
		role: "unavailable",
		availability: "listed_no_endpoints",
		dimFit: "n/a",
		jsonFit: "n/a",
		reasoning: "n/a",
		notes:
			"Same OpenRouter POST /rerank as 8B, including provider=Fireworks, still 404: no endpoints. Fireworks serverless publishes only 8B; 0.6B is dedicated-only and not routed.",
	},
	{
		id: "qwen/qwen3-reranker-4b",
		slot: "rerank",
		role: "unavailable",
		availability: "listed_no_endpoints",
		dimFit: "n/a",
		jsonFit: "n/a",
		reasoning: "n/a",
		notes:
			"Same OpenRouter POST /rerank as 8B, including provider=Fireworks, still 404. Fireworks 4B is dedicated-only, not on the OpenRouter serverless endpoint.",
	},
	{
		id: "qwen/qwen3-reranker-8b",
		slot: "rerank",
		role: "candidate",
		availability: "listed_rerank",
		dimFit: "n/a",
		jsonFit: "n/a",
		reasoning: "n/a",
		notes:
			"Available OpenRouter Qwen reranker. Fallback if 0.6B/4B stay unpublished.",
	},
	{
		id: "nvidia/llama-nemotron-rerank-vl-1b-v2:free",
		slot: "rerank",
		role: "candidate",
		availability: "listed_rerank",
		dimFit: "n/a",
		jsonFit: "n/a",
		reasoning: "n/a",
		promptUsdPerMillion: 0,
		notes: "First rerank bake-off pick: free, text+image, POST /api/v1/rerank.",
	},
	{
		id: "voyageai/rerank-2.5-lite",
		slot: "rerank",
		role: "candidate",
		availability: "listed_rerank",
		dimFit: "n/a",
		jsonFit: "n/a",
		reasoning: "n/a",
		notes:
			"Voyage latency/quality reranker. One VoyageAI endpoint, 32k context.",
	},
	{
		id: "voyageai/rerank-2.5",
		slot: "rerank",
		role: "candidate",
		availability: "listed_rerank",
		dimFit: "n/a",
		jsonFit: "n/a",
		reasoning: "n/a",
		notes: "Voyage quality reranker. One VoyageAI endpoint, 32k context.",
	},
];

export const OPENROUTER_RERANK_URL = "https://openrouter.ai/api/v1/rerank";

export function modelsForSlot(slot: MatrixSlot): CandidateModel[] {
	return CANDIDATE_MODELS.filter((model) => model.slot === slot);
}

export function speedBakeOffIds(): {
	embed: string[];
	chat: string[];
	rerank: string[];
} {
	return {
		embed: CANDIDATE_MODELS.filter(
			(model) =>
				model.slot === "embed" &&
				model.dimFit !== "incompatible" &&
				model.role !== "unavailable",
		).map((model) => model.id),
		chat: CANDIDATE_MODELS.filter(
			(model) => model.slot.startsWith("chat_") && model.role !== "unavailable",
		).map((model) => model.id),
		rerank: CANDIDATE_MODELS.filter(
			(model) =>
				model.slot === "rerank" && model.availability === "listed_rerank",
		).map((model) => model.id),
	};
}
