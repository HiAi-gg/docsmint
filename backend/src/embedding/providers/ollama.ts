/**
 * Ollama embedding provider.
 * POST to ${OLLAMA_URL}/api/embeddings with configurable model.
 */

import { logger } from "../../lib/logger";
import { normalizeDimensions } from "../utils";

const EMBEDDING_DIMENSIONS = 1024;
const TIMEOUT_MS = 30_000;

interface OllamaEmbeddingResponse {
  embedding: number[];
}

/**
 * Get an embedding vector from Ollama.
 * @param text - Text to embed
 * @param model - Model name (default: nomic-embed-text)
 * @param ollamaUrl - Ollama API base URL
 * @returns number[] of length 1024
 */
export async function getOllamaEmbedding(
  text: string,
  model: string,
  ollamaUrl: string,
): Promise<number[]> {
  const url = `${ollamaUrl}/api/embeddings`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "unknown");
      throw new Error(`Ollama embedding failed: ${response.status} ${body}`);
    }

    const data = (await response.json()) as OllamaEmbeddingResponse;
    const embedding = data.embedding;

    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error("Ollama returned empty or invalid embedding");
    }

    return normalizeDimensions(embedding, EMBEDDING_DIMENSIONS);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      logger.error({ url, model }, "Ollama embedding request timed out");
      throw new Error(`Ollama embedding timed out after ${TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

