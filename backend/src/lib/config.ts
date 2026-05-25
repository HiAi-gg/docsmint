import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().default("postgresql://aiuser:aipassword@localhost:5433/hiai_docs"),
  REDIS_URL: z.string().default("redis://localhost:6380"),
  MINIO_ENDPOINT: z.string().default("localhost"),
  MINIO_PORT: z.coerce.number().default(9010),
  MINIO_ACCESS_KEY: z.string().default("minioadmin"),
  MINIO_SECRET_KEY: z.string().default("minioadmin"),
  MINIO_BUCKET: z.string().default("hiai-docs"),
  BETTER_AUTH_SECRET: z.string().default("change-me-to-random-32-chars").refine(
    (val) => process.env.NODE_ENV !== "production" || val !== "change-me-to-random-32-chars",
    "BETTER_AUTH_SECRET must be set in production"
  ),
  BETTER_AUTH_URL: z.string().default("http://localhost:50700"),
  CORS_ORIGINS: z.string().optional(),
  EMBEDDING_PROVIDER: z.enum(["ollama", "openrouter", "voyage"]).default("ollama"),
  EMBEDDING_MODEL: z.string().default("nomic-embed-text"),
  EMBEDDING_OLLAMA_URL: z.string().default("http://localhost:11434"),
  EMBEDDING_FALLBACK_PROVIDER: z.string().default("openrouter"),
  EMBEDDING_FALLBACK_MODEL: z.string().default("openai/text-embedding-3-small"),
  OPENROUTER_API_KEY: z.string().optional(),
  API_PORT: z.coerce.number().default(50700),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  HIAI_DOCS_API_KEY: z.string().optional(),
  OWNER_ID: z.string().default("api-key-user"),
});

let config: z.infer<typeof envSchema>;
try {
  config = envSchema.parse(process.env);
} catch (err) {
  console.error("FATAL: Invalid environment configuration:", err);
  process.exit(1);
}
export { config };
