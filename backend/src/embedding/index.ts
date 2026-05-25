/**
 * Embedding pipeline entry point.
 * Provider factory with fallback logic, document chunking, and graceful degradation.
 */

import { config } from "../lib/config";
import { logger } from "../lib/logger";
import { chunkText } from "./chunker";
import { getOllamaEmbedding } from "./providers/ollama";
import { getOpenRouterEmbedding } from "./providers/openrouter";

const EMBEDDING_DIMENSIONS = 1024;

/**
 * Get an embedding vector using the primary provider.
 */
async function getPrimaryEmbedding(text: string): Promise<number[]> {
  switch (config.EMBEDDING_PROVIDER) {
    case "ollama":
      return getOllamaEmbedding(text, config.EMBEDDING_MODEL, config.EMBEDDING_OLLAMA_URL);
    case "openrouter":
      return getOpenRouterEmbedding(text, config.EMBEDDING_MODEL, config.OPENROUTER_API_KEY ?? "");
    case "voyage":
      // Voyage not yet implemented — fall through to fallback
      throw new Error("Voyage embedding provider is not yet implemented");
    default:
      throw new Error(`Unknown embedding provider: ${config.EMBEDDING_PROVIDER}`);
  }
}

/**
 * Get an embedding vector using the fallback provider.
 */
async function getFallbackEmbedding(text: string): Promise<number[]> {
  switch (config.EMBEDDING_FALLBACK_PROVIDER) {
    case "ollama":
      return getOllamaEmbedding(text, config.EMBEDDING_FALLBACK_MODEL, config.EMBEDDING_OLLAMA_URL);
    case "openrouter":
      return getOpenRouterEmbedding(text, config.EMBEDDING_FALLBACK_MODEL, config.OPENROUTER_API_KEY ?? "");
    case "voyage":
      throw new Error("Voyage embedding provider is not yet implemented");
    default:
      throw new Error(`Unknown fallback embedding provider: ${config.EMBEDDING_FALLBACK_PROVIDER}`);
  }
}

/**
 * Get an embedding vector for a single text.
 * Tries primary provider, then fallback, then returns a zero vector.
 */
export async function getEmbedding(text: string): Promise<number[]> {
  try {
    const embedding = await getPrimaryEmbedding(text);
    return embedding;
  } catch (primaryErr) {
    logger.warn(
      { err: primaryErr, provider: config.EMBEDDING_PROVIDER },
      "Primary embedding provider failed, trying fallback",
    );

    try {
      const embedding = await getFallbackEmbedding(text);
      return embedding;
    } catch (fallbackErr) {
      logger.error(
        { err: fallbackErr, provider: config.EMBEDDING_FALLBACK_PROVIDER },
        "Fallback embedding provider also failed, returning zero vector",
      );
      return new Array(EMBEDDING_DIMENSIONS).fill(0);
    }
  }
}

/**
 * Chunk a document and embed each chunk.
 * Returns one embedding vector per chunk.
 */
export async function embedDocument(title: string, content: string): Promise<number[][]> {
  const fullText = `${title}\n\n${content}`;
  const chunks = chunkText(fullText);

  if (chunks.length === 0) {
    return [new Array(EMBEDDING_DIMENSIONS).fill(0)];
  }

  const results: number[][] = [];
  for (let i = 0; i < chunks.length; i += 5) {
    const batch = chunks.slice(i, i + 5);
    const batchResults = await Promise.all(batch.map(getEmbedding));
    results.push(...batchResults);
  }

  return results;
}
