import { describe, test, expect } from "bun:test";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().default("postgresql://aiuser:aipassword@localhost:5433/hiai_docs"),
  REDIS_URL: z.string().default("redis://localhost:6380"),
  API_PORT: z.coerce.number().default(50700),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  BETTER_AUTH_SECRET: z.string().default("change-me-to-random-32-chars"),
  BETTER_AUTH_URL: z.string().default("http://localhost:50700"),
  EMBEDDING_PROVIDER: z.enum(["ollama", "openrouter", "voyage"]).default("ollama"),
  EMBEDDING_MODEL: z.string().default("nomic-embed-text"),
  EMBEDDING_OLLAMA_URL: z.string().default("http://localhost:11434"),
  EMBEDDING_FALLBACK_PROVIDER: z.string().default("openrouter"),
  EMBEDDING_FALLBACK_MODEL: z.string().default("openai/text-embedding-3-small"),
  OPENROUTER_API_KEY: z.string().optional(),
  MINIO_ENDPOINT: z.string().default("localhost"),
  MINIO_PORT: z.coerce.number().default(9010),
  MINIO_ACCESS_KEY: z.string().default("minioadmin"),
  MINIO_SECRET_KEY: z.string().default("minioadmin"),
  MINIO_BUCKET: z.string().default("hiai-docs"),
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
      expect(result.data.EMBEDDING_PROVIDER).toBe("ollama");
      expect(result.data.MINIO_PORT).toBe(9010);
    }
  });

  test("rejects invalid NODE_ENV", () => {
    const result = envSchema.safeParse({ NODE_ENV: "staging" });
    expect(result.success).toBe(false);
  });

  test("accepts valid embedding providers", () => {
    expect(envSchema.safeParse({ EMBEDDING_PROVIDER: "ollama" }).success).toBe(true);
    expect(envSchema.safeParse({ EMBEDDING_PROVIDER: "openrouter" }).success).toBe(true);
    expect(envSchema.safeParse({ EMBEDDING_PROVIDER: "voyage" }).success).toBe(true);
    expect(envSchema.safeParse({ EMBEDDING_PROVIDER: "invalid" }).success).toBe(false);
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

  test("OPENROUTER_API_KEY is optional", () => {
    const result = envSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.OPENROUTER_API_KEY).toBeUndefined();
    }
  });
});
