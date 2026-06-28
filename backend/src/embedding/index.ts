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
 * Optional metadata used to enrich the chunk text before embedding.
 * When any field is present, a "Folder: ...", "Tags: ...", or "Category: ..."
 * line is prepended to the chunk so semantic search can use folder/tag/category
 * context to disambiguate documents.
 *
 * All fields are optional. Passing `undefined` or an empty object preserves
 * the original (metadata-free) embedding behavior — used by callers that do
 * not have metadata available, e.g. legacy/test paths.
 */
export interface EmbeddingMetadata {
	folderName?: string;
	tagNames?: string[];
	categoryName?: string;
}

/**
 * Build the metadata preamble that gets prepended to the embedding text.
 * Returns an empty string when no metadata is supplied so the chunk text is
 * identical to the legacy `title + content` form (backward compatible).
 */
export function buildMetadataPreamble(metadata?: EmbeddingMetadata): string {
	if (!metadata) return "";
	const lines: string[] = [];
	if (metadata.folderName && metadata.folderName.trim().length > 0) {
		lines.push(`Folder: ${metadata.folderName.trim()}`);
	}
	if (metadata.tagNames && metadata.tagNames.length > 0) {
		const cleaned = metadata.tagNames
			.map((t) => t.trim())
			.filter((t) => t.length > 0);
		if (cleaned.length > 0) {
			lines.push(`Tags: ${cleaned.join(", ")}`);
		}
	}
	if (metadata.categoryName && metadata.categoryName.trim().length > 0) {
		lines.push(`Category: ${metadata.categoryName.trim()}`);
	}
	if (lines.length === 0) return "";
	return `${lines.join("\n")}\n\n`;
}

/**
 * Chunk a document and embed each chunk.
 * Returns one embedding vector per chunk.
 *
 * When `metadata` is supplied, its fields are prepended to the chunk text so
 * the resulting embeddings reflect folder/tag/category context. Without
 * metadata, the chunk text is just `title + content` (legacy behavior).
 */
export async function embedDocument(
	title: string,
	content: string,
	metadata?: EmbeddingMetadata,
): Promise<number[][]> {
	const preamble = buildMetadataPreamble(metadata);
	const fullText = `${preamble}${title}\n\n${content}`;
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
