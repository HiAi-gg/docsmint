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
	STORAGE_PORT: z.coerce.number().default(9020),
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
			expect(result.data.STORAGE_PORT).toBe(9020);
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

	test("accepts real non-empty secrets in production", () => {
		process.env.NODE_ENV = "production";
		const result = realEnvSchema.safeParse({
			BETTER_AUTH_SECRET: "real-better-auth-secret-32-chars-long",
			CSRF_SECRET: "real-csrf-secret-32-chars-long-bbbb",
			WEBHOOK_SECRET: "real-webhook-secret-32-chars-long-cc",
		});
		expect(result.success).toBe(true);
	});

	test("accepts default secrets in development (non-production)", () => {
		process.env.NODE_ENV = "development";
		const result = realEnvSchema.safeParse({});
		expect(result.success).toBe(true);
	});
});
