/**
 * Embedding pipeline entry point.
 * Provider factory with fallback logic, document chunking, and graceful degradation.
 */

import { config } from "../lib/config";
import { logger } from "../lib/logger";
import { incrementCounter, METRIC_NAMES, recordDuration } from "../lib/metrics";
import { chunkText } from "./chunker";
import { getOpenAICompatibleEmbedding } from "./providers/openai-compatible";
import { EMBEDDING_DIMENSIONS } from "./utils";

/**
 * Get an embedding vector for a single text.
 * Tries primary provider, then fallback, then returns a zero vector.
 *
 * Observability: records a duration sample for every call and increments
 * one of `embedding_success` / `embedding_fallback` / `embedding_zero`
 * based on the outcome. Operators surface these via
 * `/api/admin/metrics`. The duration sample is recorded in a `finally`
 * block so an unexpected throw in the provider still produces a metric
 * sample (the counter increment is intentionally skipped on that path —
 * we don't want to mis-classify exceptions as zero-vector fallbacks).
 */
export async function getEmbedding(text: string): Promise<number[]> {
	const start = Date.now();
	try {
		return await getEmbeddingInner(text);
	} finally {
		recordDuration(METRIC_NAMES.EMBEDDING_DURATION_MS, Date.now() - start);
	}
}

/**
 * Inner implementation of `getEmbedding` that owns the provider fan-out
 * and the per-outcome counter increments. Split out from the outer
 * function so the outer try/finally can wrap the whole call without
 * duplicating increment logic in every return branch.
 */
async function getEmbeddingInner(text: string): Promise<number[]> {
	if (!config.EMBEDDING_BASE_URL || !config.EMBEDDING_MODEL) {
		logger.warn(
			"Embedding primary provider not configured (EMBEDDING_BASE_URL or EMBEDDING_MODEL missing), returning zero vector",
		);
		incrementCounter(METRIC_NAMES.EMBEDDING_ZERO);
		return new Array(EMBEDDING_DIMENSIONS).fill(0);
	}

	try {
		const vector = await getOpenAICompatibleEmbedding(
			text,
			config.EMBEDDING_BASE_URL,
			config.EMBEDDING_API_KEY ?? "",
			config.EMBEDDING_MODEL,
			config.EMBEDDING_TIMEOUT_MS,
		);
		incrementCounter(METRIC_NAMES.EMBEDDING_SUCCESS);
		return vector;
	} catch (primaryErr) {
		logger.warn(
			{ err: primaryErr, model: config.EMBEDDING_MODEL },
			"Primary embedding provider failed, trying fallback",
		);

		if (config.EMBEDDING_FALLBACK_BASE_URL && config.EMBEDDING_FALLBACK_MODEL) {
			try {
				const vector = await getOpenAICompatibleEmbedding(
					text,
					config.EMBEDDING_FALLBACK_BASE_URL,
					config.EMBEDDING_FALLBACK_API_KEY ?? "",
					config.EMBEDDING_FALLBACK_MODEL,
					config.EMBEDDING_TIMEOUT_MS,
				);
				incrementCounter(METRIC_NAMES.EMBEDDING_FALLBACK);
				return vector;
			} catch (fallbackErr) {
				logger.error(
					{ err: fallbackErr, model: config.EMBEDDING_FALLBACK_MODEL },
					"Fallback embedding provider also failed, returning zero vector",
				);
				incrementCounter(METRIC_NAMES.EMBEDDING_ZERO);
			}
		} else {
			logger.warn(
				"Embedding fallback provider not configured, returning zero vector",
			);
			incrementCounter(METRIC_NAMES.EMBEDDING_ZERO);
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
 * Pair of (chunk text, embedding vector) returned by `embedDocument`.
 * Callers store both fields so the chunk text round-trips with its vector
 * and can be surfaced later for highlight/snippet UIs and re-embedding.
 */
export interface EmbeddingChunk {
	chunkText: string;
	embedding: number[];
	charStart: number;
	charEnd: number;
}

/**
 * Chunk a document and embed each chunk.
 * Returns one `{ chunkText, embedding }` pair per chunk so callers can
 * persist the original chunk text alongside its vector.
 *
 * When `metadata` is supplied, its fields are prepended to the chunk text so
 * the resulting embeddings reflect folder/tag/category context. Without
 * metadata, the chunk text is just `title + content` (legacy behavior).
 */
export async function embedDocument(
	title: string,
	content: string,
	metadata?: EmbeddingMetadata,
): Promise<EmbeddingChunk[]> {
	const preamble = buildMetadataPreamble(metadata);
	const fullText = `${preamble}${title}\n\n${content}`;
	const chunks = chunkText(fullText);

	if (chunks.length === 0) {
		return [
			{
				chunkText: "",
				embedding: new Array(EMBEDDING_DIMENSIONS).fill(0),
				charStart: 0,
				charEnd: 0,
			},
		];
	}

	const results: EmbeddingChunk[] = [];
	for (let i = 0; i < chunks.length; i += 5) {
		const batch = chunks.slice(i, i + 5);
		const batchEmbeddings = await Promise.all(
			batch.map((chunk) => getEmbedding(chunk.text)),
		);
		for (let j = 0; j < batchEmbeddings.length; j++) {
			// `j < batch.length` and `j < batchEmbeddings.length` are both
			// guaranteed by the outer loop bounds and the parallel Promise.all
			// above, but the index-access through `noUncheckedIndexedAccess`
			// widens these to `T | undefined`. The optional chain short-
			// circuits cleanly if a future refactor breaks the invariant
			// instead of crashing on `undefined.text`.
			const chunk = batch[j];
			const embedding = batchEmbeddings[j];
			if (!chunk || !embedding) continue;
			results.push({
				chunkText: chunk.text,
				embedding,
				charStart: chunk.charStart,
				charEnd: chunk.charEnd,
			});
		}
	}

	return results;
}
