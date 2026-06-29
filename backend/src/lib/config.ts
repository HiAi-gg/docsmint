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
	// Maximum attachment (image) size in MB enforced by the presigned-upload
	// endpoints. Default 25 MB — well above the legacy 10 MB ceiling but
	// still small enough to bound MinIO storage exposure from a single
	// authenticated user. The legacy POST /documents/:id/attachments route
	// keeps its own 10 MB cap to preserve backwards compatibility.
	ATTACHMENT_MAX_SIZE_MB: z.coerce.number().int().min(1).max(500).default(25),
	// Presigned PUT URL lifetime in seconds. Default 15 min — enough for a
	// slow residential upload of a 25 MB image but short enough that a
	// leaked URL becomes useless quickly.
	ATTACHMENT_PRESIGN_EXPIRY_SECONDS: z.coerce
		.number()
		.int()
		.min(60)
		.max(3600)
		.default(900),
	// Chunking (optional, defaults: 500 tokens, 50 overlap)
	CHUNK_TARGET_TOKENS: z.coerce.number().int().min(100).max(2000).default(500),
	CHUNK_OVERLAP_TOKENS: z.coerce.number().int().min(0).max(500).default(50),
	// Apache AGE (GraphRAG) lives in the same database as the rest of
	// the data, so there is no separate AGE connection string. The
	// presence of the `age` extension in the shared database is
	// detected at runtime by `lib/graph/init.ts` and graph features
	// degrade gracefully if the extension is missing.
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
	// Minimum confidence (0.0–1.0) for entities to be persisted. Entities
	// extracted by the LLM with confidence strictly below this threshold are
	// dropped during parsing — they still count as cache misses but never
	// reach AGE. Default 0.5 keeps moderate-confidence extractions while
	// discarding speculative ones.
	GRAPH_EXTRACT_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.5),
	// Hybrid search weights — applied to the merged text + semantic score.
	// Both must be in [0, 1]; defaults preserve the historical 0.4 text /
	// 0.6 semantic balance from the README contract.
	// Graph-augmented search boost. Multiplier applied to graph-derived
	// documents when they are merged into a search result list (existing
	// documents get this same fraction as a multiplicative boost on their
	// own score, new neighbors get this as their initial score). Default
	// 0.3 keeps the ranking honest - a graph neighbor scores BELOW a
	// single semantic match but ABOVE the noise floor. Tune up for
	// graph-heavy corpora, tune down if graph results crowd out semantic
	// hits. Range [0, 2]; 0 disables graph boost entirely.
	GRAPH_EXPANSION_BOOST: z.coerce.number().min(0).max(2).default(0.3),
	// When `false`, admin reindex endpoints require an explicit `?ownerId=`
	// query parameter. When `true` (default, backward-compatible), they are
	// cross-tenant and the ownerId parameter is optional.
	ADMIN_CROSS_TENANT: z
		.string()
		.optional()
		.default("true")
		.transform((v) => v === "true"),
	HYBRID_TEXT_WEIGHT: z.coerce.number().min(0).max(1).default(0.4),
	HYBRID_SEMANTIC_WEIGHT: z.coerce.number().min(0).max(1).default(0.6),
	// Metadata-triggered re-embed batch caps. When a folder / category /
	// tag is renamed or deleted, every affected document needs a fresh
	// embedding because the preamble includes those names. The cap
	// bounds how many docs can be re-embedded in a single tick so a
	// rename of a mega-folder doesn't spike embedding costs. Set to 0
	// to disable the cap (process everything in one go - not recommended
	// for production with >10k docs per folder).
	FOLDER_REEMBED_BATCH_SIZE: z.coerce.number().int().min(0).default(100),
	CATEGORY_REEMBED_BATCH_SIZE: z.coerce.number().int().min(0).default(100),
	TAG_REEMBED_BATCH_SIZE: z.coerce.number().int().min(0).default(500),
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
