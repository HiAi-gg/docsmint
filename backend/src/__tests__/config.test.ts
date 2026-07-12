import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { envSchema as realEnvSchema } from "../lib/config-schema";

const envSchema = z.object({
	DATABASE_URL: z
		.string()
		.default("postgresql://aiuser:changeme@localhost:5433/hiai_docs"),
	REDIS_URL: z.string().default("redis://localhost:6380"),
	API_PORT: z.coerce.number().default(50700),
	NODE_ENV: z
		.enum(["development", "production", "test"])
		.default("development"),
	LOG_LEVEL: z
		.enum(["trace", "debug", "info", "warn", "error", "fatal"])
		.default("info"),
	BETTER_AUTH_SECRET: z.string().default("change-me-to-random-32-chars"),
	BETTER_AUTH_URL: z.string().default("http://localhost:50700"),
	EMBEDDING_BASE_URL: z.string().optional(),
	EMBEDDING_API_KEY: z.string().optional(),
	EMBEDDING_MODEL: z.string().optional(),
	EMBEDDING_FALLBACK_BASE_URL: z.string().optional(),
	EMBEDDING_FALLBACK_API_KEY: z.string().optional(),
	EMBEDDING_FALLBACK_MODEL: z.string().optional(),
	STORAGE_ENDPOINT: z.string().default("localhost"),
	STORAGE_PORT: z.coerce.number().default(50702),
	STORAGE_ACCESS_KEY: z.string().default("minioadmin"),
	STORAGE_SECRET_KEY: z.string().default("minioadmin"),
	STORAGE_BUCKET: z.string().default("hiai-docs"),
	STORAGE_REGION: z.string().default("us-east-1"),
	STORAGE_FORCE_PATH_STYLE: z.boolean().default(true),
	HIAI_DOCS_API_KEY: z.string().optional(),
	OWNER_ID: z.string().default("api-key-user"),
});

describe("config schema", () => {
	test("loads with defaults when env vars are unset", () => {
		const result = envSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.API_PORT).toBe(50700);
			expect(result.data.NODE_ENV).toBe("development");
			expect(result.data.LOG_LEVEL).toBe("info");
			expect(result.data.EMBEDDING_BASE_URL).toBeUndefined();
			expect(result.data.EMBEDDING_API_KEY).toBeUndefined();
			expect(result.data.EMBEDDING_MODEL).toBeUndefined();
			expect(result.data.EMBEDDING_FALLBACK_BASE_URL).toBeUndefined();
			expect(result.data.EMBEDDING_FALLBACK_API_KEY).toBeUndefined();
			expect(result.data.EMBEDDING_FALLBACK_MODEL).toBeUndefined();
			expect(result.data.STORAGE_PORT).toBe(50702);
		}
	});

	test("rejects invalid NODE_ENV", () => {
		const result = envSchema.safeParse({ NODE_ENV: "staging" });
		expect(result.success).toBe(false);
	});

	test("accepts valid embedding configuration", () => {
		const result = envSchema.safeParse({
			EMBEDDING_BASE_URL: "http://localhost:11434",
			EMBEDDING_API_KEY: "test-api-key",
			EMBEDDING_MODEL: "nomic-embed-text",
			EMBEDDING_FALLBACK_BASE_URL: "https://openrouter.ai/api/v1",
			EMBEDDING_FALLBACK_API_KEY: "fallback-api-key",
			EMBEDDING_FALLBACK_MODEL: "openai/text-embedding-3-small",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.EMBEDDING_BASE_URL).toBe("http://localhost:11434");
			expect(result.data.EMBEDDING_API_KEY).toBe("test-api-key");
			expect(result.data.EMBEDDING_MODEL).toBe("nomic-embed-text");
			expect(result.data.EMBEDDING_FALLBACK_BASE_URL).toBe(
				"https://openrouter.ai/api/v1",
			);
			expect(result.data.EMBEDDING_FALLBACK_API_KEY).toBe("fallback-api-key");
			expect(result.data.EMBEDDING_FALLBACK_MODEL).toBe(
				"openai/text-embedding-3-small",
			);
		}
	});

	test("coerces string port to number", () => {
		const result = envSchema.safeParse({ API_PORT: "8080" });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.API_PORT).toBe(8080);
			expect(typeof result.data.API_PORT).toBe("number");
		}
	});

	test("accepts valid LOG_LEVEL", () => {
		for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) {
			expect(envSchema.safeParse({ LOG_LEVEL: level }).success).toBe(true);
		}
		expect(envSchema.safeParse({ LOG_LEVEL: "verbose" }).success).toBe(false);
	});

	test("all embedding fields are optional and default to undefined", () => {
		const result = envSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.EMBEDDING_BASE_URL).toBeUndefined();
			expect(result.data.EMBEDDING_API_KEY).toBeUndefined();
			expect(result.data.EMBEDDING_MODEL).toBeUndefined();
			expect(result.data.EMBEDDING_FALLBACK_BASE_URL).toBeUndefined();
			expect(result.data.EMBEDDING_FALLBACK_API_KEY).toBeUndefined();
			expect(result.data.EMBEDDING_FALLBACK_MODEL).toBeUndefined();
		}
	});

	test("accepts supported GraphRAG reasoning effort values", () => {
		for (const effort of ["none", "low", "medium", "high", "max"]) {
			const result = realEnvSchema.safeParse({
				GRAPH_EXTRACT_REASONING_EFFORT: effort,
			});
			expect(result.success).toBe(true);
		}
		expect(
			realEnvSchema.safeParse({ GRAPH_EXTRACT_REASONING_EFFORT: "off" })
				.success,
		).toBe(false);
	});

	test("accepts shared OpenRouter key for public embedding profile", () => {
		const result = realEnvSchema.safeParse({
			OPENROUTER_API_KEY: "test-openrouter-key",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.OPENROUTER_API_KEY).toBe("test-openrouter-key");
		}
	});

	test("rejects a non-UUID API owner before document writes reach PostgreSQL", () => {
		expect(
			realEnvSchema.safeParse({ OWNER_ID: "your-user-uuid-from-auth" }).success,
		).toBe(false);
	});

	test("loads adaptive search defaults", () => {
		const result = realEnvSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.SEARCH_EXPANSION_ENABLED).toBe(true);
			expect(result.data.SEARCH_EXPANSION_MODEL).toBe(
				"mistralai/ministral-14b-2512",
			);
			expect(result.data.SEARCH_EXPANSION_FALLBACK_MODEL).toBe(
				"google/gemma-4-31b-it",
			);
			expect(result.data.SEARCH_EXPANSION_TIMEOUT_MS).toBe(6_000);
			expect(result.data.SEARCH_VECTOR_PROVIDER_TIMEOUT_MS).toBe(2_500);
			expect(result.data.SEARCH_EXPANSION_MAX_VARIANTS).toBe(12);
			expect(result.data.SEARCH_RRF_K).toBe(60);
		}
	});

	test("loads bounded BullMQ and provider limiter defaults", () => {
		const result = realEnvSchema.safeParse({});
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.QUEUE_EMBED_CONCURRENCY).toBe(3);
		expect(result.data.QUEUE_EMBED_BATCH_SIZE).toBe(5);
		expect(result.data.QUEUE_JOB_ATTEMPTS).toBe(5);
		expect(result.data.PROVIDER_LIMITER_MODE).toBe("remote");
		expect(result.data.PROVIDER_REQUESTS_PER_MINUTE).toBe(0);
		expect(result.data.OLLAMA_PORT).toBe(11434);
	});

	test("treats an empty optional Ollama URL from Compose as unset", () => {
		const result = realEnvSchema.safeParse({ EMBEDDING_OLLAMA_URL: "" });
		expect(result.success).toBe(true);
		if (result.success)
			expect(result.data.EMBEDDING_OLLAMA_URL).toBeUndefined();
		expect(
			realEnvSchema.safeParse({ EMBEDDING_OLLAMA_URL: "not-a-url" }).success,
		).toBe(false);
	});

	test("rejects unsafe queue and provider runtime bounds", () => {
		expect(
			realEnvSchema.safeParse({ QUEUE_EMBED_CONCURRENCY: 0 }).success,
		).toBe(false);
		expect(
			realEnvSchema.safeParse({ QUEUE_EMBED_BATCH_SIZE: 33 }).success,
		).toBe(false);
		expect(
			realEnvSchema.safeParse({ PROVIDER_LIMITER_MODE: "invalid" }).success,
		).toBe(false);
		expect(
			realEnvSchema.safeParse({ PROVIDER_REQUESTS_PER_MINUTE: -1 }).success,
		).toBe(false);
		expect(realEnvSchema.safeParse({ OLLAMA_PORT: 70000 }).success).toBe(false);
	});

	test("accepts custom search expansion provider settings", () => {
		const result = realEnvSchema.safeParse({
			OWNER_ID: "00000000-0000-4000-8000-000000000001",
			SEARCH_EXPANSION_ENABLED: "false",
			SEARCH_EXPANSION_BASE_URL: "http://ollama:11434/v1",
			SEARCH_EXPANSION_API_KEY: "",
			SEARCH_EXPANSION_TIMEOUT_MS: "5000",
			SEARCH_VECTOR_MIN_SIMILARITY: "0.4",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.SEARCH_EXPANSION_ENABLED).toBe(false);
			expect(result.data.SEARCH_EXPANSION_BASE_URL).toBe(
				"http://ollama:11434/v1",
			);
			expect(result.data.SEARCH_EXPANSION_TIMEOUT_MS).toBe(5_000);
			expect(result.data.SEARCH_VECTOR_MIN_SIMILARITY).toBe(0.4);
		}
	});
});

// Production secret guards — the real schema (config-schema.ts) must reject
// default/empty signing secrets when NODE_ENV=production. These cover the
// security hole where docker-compose renders an unset ${CSRF_SECRET} as an
// empty string: zod .min(1) catches the empty string before the .refine()
// default-value check runs.
describe("production secret guards (real schema)", () => {
	const originalNodeEnv = process.env.NODE_ENV;

	afterEach(() => {
		process.env.NODE_ENV = originalNodeEnv;
	});

	test("rejects default BETTER_AUTH_SECRET in production", () => {
		process.env.NODE_ENV = "production";
		const result = realEnvSchema.safeParse({
			BETTER_AUTH_SECRET: "change-me-to-random-32-chars",
		});
		expect(result.success).toBe(false);
	});

	test("rejects empty BETTER_AUTH_SECRET in production", () => {
		process.env.NODE_ENV = "production";
		const result = realEnvSchema.safeParse({ BETTER_AUTH_SECRET: "" });
		expect(result.success).toBe(false);
	});

	test("rejects empty CSRF_SECRET in production", () => {
		process.env.NODE_ENV = "production";
		const result = realEnvSchema.safeParse({
			BETTER_AUTH_SECRET: "real-secret-32-chars-long-aaaaaa",
			CSRF_SECRET: "",
		});
		expect(result.success).toBe(false);
	});

	test("rejects empty WEBHOOK_SECRET in production", () => {
		process.env.NODE_ENV = "production";
		const result = realEnvSchema.safeParse({
			BETTER_AUTH_SECRET: "real-secret-32-chars-long-aaaaaa",
			WEBHOOK_SECRET: "",
		});
		expect(result.success).toBe(false);
	});

	test("rejects default CSRF_SECRET in production", () => {
		process.env.NODE_ENV = "production";
		const result = realEnvSchema.safeParse({
			BETTER_AUTH_SECRET: "real-secret-32-chars-long-aaaaaa",
			CSRF_SECRET: "change-me-to-random-32-chars",
		});
		expect(result.success).toBe(false);
	});

	test("rejects default WEBHOOK_SECRET in production", () => {
		process.env.NODE_ENV = "production";
		const result = realEnvSchema.safeParse({
			BETTER_AUTH_SECRET: "real-secret-32-chars-long-aaaaaa",
			WEBHOOK_SECRET: "change-me-to-random-32-chars",
		});
		expect(result.success).toBe(false);
	});

	test("rejects default category API key encryption secret in production", () => {
		process.env.NODE_ENV = "production";
		const result = realEnvSchema.safeParse({
			OWNER_ID: "00000000-0000-4000-8000-000000000001",
			BETTER_AUTH_SECRET: "real-secret-32-chars-long-aaaaaa",
			CSRF_SECRET: "real-csrf-secret-32-chars-long-bbbb",
			WEBHOOK_SECRET: "real-webhook-secret-32-chars-long-cccc",
			API_KEY_ENCRYPTION_SECRET: "change-me-to-random-32-chars-long",
		});
		expect(result.success).toBe(false);
	});

	test("rejects a missing admin API key in production", () => {
		process.env.NODE_ENV = "production";
		const result = realEnvSchema.safeParse({
			NODE_ENV: "production",
			OWNER_ID: "00000000-0000-4000-8000-000000000001",
			API_KEY_ENCRYPTION_SECRET: "real-api-key-encryption-secret-32-chars",
			BETTER_AUTH_SECRET: "real-better-auth-secret-32-chars-long",
			CSRF_SECRET: "real-csrf-secret-32-chars-long-bbbb",
			WEBHOOK_SECRET: "real-webhook-secret-32-chars-long-cc",
		});
		expect(result.success).toBe(false);
	});

	test("rejects placeholder admin API keys in production", () => {
		process.env.NODE_ENV = "production";
		for (const apiKey of [
			"change-me-generate-new-key",
			"changeme",
			"your-api-key",
		]) {
			const result = realEnvSchema.safeParse({
				NODE_ENV: "production",
				OWNER_ID: "00000000-0000-4000-8000-000000000001",
				API_KEY_ENCRYPTION_SECRET: "real-api-key-encryption-secret-32-chars",
				BETTER_AUTH_SECRET: "real-better-auth-secret-32-chars-long",
				CSRF_SECRET: "real-csrf-secret-32-chars-long-bbbb",
				WEBHOOK_SECRET: "real-webhook-secret-32-chars-long-cc",
				HIAI_DOCS_API_KEY: apiKey,
			});
			expect(result.success).toBe(false);
		}
	});

	test("accepts real non-empty secrets in production", () => {
		process.env.NODE_ENV = "production";
		const result = realEnvSchema.safeParse({
			NODE_ENV: "production",
			OWNER_ID: "00000000-0000-4000-8000-000000000001",
			API_KEY_ENCRYPTION_SECRET: "real-api-key-encryption-secret-32-chars",
			BETTER_AUTH_SECRET: "real-better-auth-secret-32-chars-long",
			CSRF_SECRET: "real-csrf-secret-32-chars-long-bbbb",
			WEBHOOK_SECRET: "real-webhook-secret-32-chars-long-cc",
			HIAI_DOCS_API_KEY: "real-admin-api-key-generated-for-production",
		});
		expect(result.success).toBe(true);
	});

	test("accepts default secrets in development (non-production)", () => {
		process.env.NODE_ENV = "development";
		const result = realEnvSchema.safeParse({});
		expect(result.success).toBe(true);
	});
});
