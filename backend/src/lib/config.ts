import { z } from "zod";
import { logger } from "./logger";

const envSchema = z.object({
	DATABASE_URL: z
		.string()
		.default("postgresql://aiuser:changeme@localhost:5433/hiai_docs"),
	REDIS_URL: z.string().default("redis://localhost:6384"),
	MINIO_ENDPOINT: z.string().default("localhost"),
	MINIO_PORT: z.coerce.number().default(9020),
	MINIO_PUBLIC_ENDPOINT: z.string().default("localhost"),
	MINIO_PUBLIC_PORT: z.coerce.number().default(9020),
	MINIO_ACCESS_KEY: z.string().default("minioadmin"),
	MINIO_SECRET_KEY: z.string().default("change-me-to-random-32-chars"),
	MINIO_BUCKET: z.string().default("hiai-docs"),
	BETTER_AUTH_SECRET: z
		.string()
		.default("change-me-to-random-32-chars")
		.refine(
			(val) =>
				process.env.NODE_ENV !== "production" ||
				val !== "change-me-to-random-32-chars",
			"BETTER_AUTH_SECRET must be set in production",
		),
	// CSRF: dedicated signing key — must NOT equal BETTER_AUTH_SECRET
	CSRF_SECRET: z.string().default("change-me-to-random-32-chars"),
	// Webhook: dedicated HMAC key — must NOT equal MINIO_SECRET_KEY
	WEBHOOK_SECRET: z.string().default("change-me-to-random-32-chars"),
	BETTER_AUTH_URL: z.string().default("http://localhost:50700"),
	CORS_ORIGINS: z.string().optional(),
	EMBEDDING_BASE_URL: z.string().optional(),
	EMBEDDING_API_KEY: z.string().optional(),
	EMBEDDING_MODEL: z.string().optional(),
	EMBEDDING_FALLBACK_BASE_URL: z.string().optional(),
	EMBEDDING_FALLBACK_API_KEY: z.string().optional(),
	EMBEDDING_FALLBACK_MODEL: z.string().optional(),
	API_PORT: z.coerce.number().default(50700),
	NODE_ENV: z
		.enum(["development", "production", "test"])
		.default("development"),
	LOG_LEVEL: z
		.enum(["trace", "debug", "info", "warn", "error", "fatal"])
		.default("info"),
	HIAI_DOCS_API_KEY: z.string().optional(),
	OWNER_ID: z.string().default("api-key-user"),
	// Number of auto-saved (non-snapshot) versions to retain per document.
	// Snapshots are never pruned. Default 50.
	VERSION_RETENTION_COUNT: z.coerce.number().default(50),
	// Chunking (optional, defaults: 500 tokens, 50 overlap)
	CHUNK_TARGET_TOKENS: z.coerce.number().int().min(100).max(2000).default(500),
	CHUNK_OVERLAP_TOKENS: z.coerce.number().int().min(0).max(500).default(50),
	// Apache AGE (GraphRAG) — separate PostgreSQL instance with the AGE
	// extension. Optional; when absent, graph features degrade gracefully.
	AGE_DATABASE_URL: z.string().optional(),
	// GraphRAG feature flags. Both default to `false` so graph code paths
	// stay dormant until the operator explicitly enables them.
	GRAPH_EXTRACT_ENABLED: z
		.string()
		.optional()
		.default("false")
		.transform((v) => v === "true"),
	GRAPH_SEARCH_ENABLED: z
		.string()
		.optional()
		.default("false")
		.transform((v) => v === "true"),
	// LLM used by entity extraction. Defaults to `EMBEDDING_MODEL` so the
	// GraphRAG extractor reuses the configured embedding provider's model
	// name where possible; falls back to `gpt-4o-mini` if neither is set.
	GRAPH_EXTRACT_MODEL: z.string().optional(),
	// Base URL for the LLM that performs entity extraction. This endpoint
	// MUST accept OpenAI-compatible chat completion requests
	// (POST {url}/chat/completions). When absent, falls back to
	// EMBEDDING_BASE_URL — which is usually WRONG (embedding endpoint !=
	// chat endpoint). Set this explicitly for production.
	GRAPH_EXTRACT_BASE_URL: z.string().optional(),
	// API key for the entity extraction LLM. Optional; defaults to
	// EMBEDDING_API_KEY when absent.
	GRAPH_EXTRACT_API_KEY: z.string().optional(),
	// Fallback LLM for entity extraction.
	GRAPH_EXTRACT_FALLBACK_BASE_URL: z.string().optional(),
	GRAPH_EXTRACT_FALLBACK_API_KEY: z.string().optional(),
	GRAPH_EXTRACT_FALLBACK_MODEL: z.string().optional(),
	// Hybrid search weights — applied to the merged text + semantic score.
	// Both must be in [0, 1]; defaults preserve the historical 0.4 text /
	// 0.6 semantic balance from the README contract.
	HYBRID_TEXT_WEIGHT: z.coerce.number().min(0).max(1).default(0.4),
	HYBRID_SEMANTIC_WEIGHT: z.coerce.number().min(0).max(1).default(0.6),
});

let config: z.infer<typeof envSchema>;
try {
	config = envSchema.parse(process.env);
} catch (err) {
	logger.error({ err }, "FATAL: Invalid environment configuration");
	process.exit(1);
}

if (config.NODE_ENV !== "production") {
	if (!process.env.CSRF_SECRET) {
		logger.warn(
			"[config] CSRF_SECRET is not set — using insecure dev fallback. " +
				"Set CSRF_SECRET in .env for any non-development environment.",
		);
	}
	if (!process.env.WEBHOOK_SECRET) {
		logger.warn(
			"[config] WEBHOOK_SECRET is not set — using insecure dev fallback. " +
				"Set WEBHOOK_SECRET in .env for any non-development environment.",
		);
	}
}

export { config };
