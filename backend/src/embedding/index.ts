/**
 * Embedding pipeline entry point.
 * Provider factory with fallback logic, document chunking, and graceful degradation.
 */

import { config } from "../lib/config";
import { logger } from "../lib/logger";
import { chunkText } from "./chunker";
import { getOpenAICompatibleEmbedding } from "./providers/openai-compatible";
import { EMBEDDING_DIMENSIONS } from "./utils";

/**
 * Get an embedding vector for a single text.
 * Tries primary provider, then fallback, then returns a zero vector.
 */
export async function getEmbedding(text: string): Promise<number[]> {
	if (!config.EMBEDDING_BASE_URL || !config.EMBEDDING_MODEL) {
		logger.warn(
			"Embedding primary provider not configured (EMBEDDING_BASE_URL or EMBEDDING_MODEL missing), returning zero vector",
		);
		return new Array(EMBEDDING_DIMENSIONS).fill(0);
	}

	try {
		return await getOpenAICompatibleEmbedding(
			text,
			config.EMBEDDING_BASE_URL,
			config.EMBEDDING_API_KEY ?? "",
			config.EMBEDDING_MODEL,
		);
	} catch (primaryErr) {
		logger.warn(
			{ err: primaryErr, model: config.EMBEDDING_MODEL },
			"Primary embedding provider failed, trying fallback",
		);

		if (config.EMBEDDING_FALLBACK_BASE_URL && config.EMBEDDING_FALLBACK_MODEL) {
			try {
				return await getOpenAICompatibleEmbedding(
					text,
					config.EMBEDDING_FALLBACK_BASE_URL,
					config.EMBEDDING_FALLBACK_API_KEY ?? "",
					config.EMBEDDING_FALLBACK_MODEL,
				);
			} catch (fallbackErr) {
				logger.error(
					{ err: fallbackErr, model: config.EMBEDDING_FALLBACK_MODEL },
					"Fallback embedding provider also failed, returning zero vector",
				);
			}
		} else {
			logger.warn(
				"Embedding fallback provider not configured, returning zero vector",
			);
		}

		return new Array(EMBEDDING_DIMENSIONS).fill(0);
	}
}

/**
 * Chunk a document and embed each chunk.
 * Returns one embedding vector per chunk.
 */
export async function embedDocument(
	title: string,
	content: string,
): Promise<number[][]> {
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
