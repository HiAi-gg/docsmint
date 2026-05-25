/**
 * OpenRouter embedding provider.
 * POST to https://openrouter.ai/api/v1/embeddings using OPENROUTER_API_KEY.
 */

import { logger } from "../../lib/logger";
import { normalizeDimensions } from "../utils";

const EMBEDDING_DIMENSIONS = 1024;
const TIMEOUT_MS = 30_000;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/embeddings";

interface OpenRouterEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

/**
 * Get an embedding vector from OpenRouter.
 * @param text - Text to embed
 * @param model - Model name (default: openai/text-embedding-3-small)
 * @param apiKey - OpenRouter API key
 * @returns number[] of length 1024
 */
export async function getOpenRouterEmbedding(
  text: string,
  model: string,
  apiKey: string,
): Promise<number[]> {
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required for OpenRouter embeddings");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: text }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "unknown");
      throw new Error(`OpenRouter embedding failed: ${response.status} ${body}`);
    }

    const data = (await response.json()) as OpenRouterEmbeddingResponse;
    const embedding = data.data?.[0]?.embedding;

    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error("OpenRouter returned empty or invalid embedding");
    }

    return normalizeDimensions(embedding, EMBEDDING_DIMENSIONS);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      logger.error({ model }, "OpenRouter embedding request timed out");
      throw new Error(`OpenRouter embedding timed out after ${TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

