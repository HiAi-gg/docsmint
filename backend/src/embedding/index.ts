/**
 * Embedding pipeline entry point.
 * Provider factory with fallback logic, document chunking, and graceful degradation.
 */

import { config } from "../lib/config";
import { logger } from "../lib/logger";
import { incrementCounter, METRIC_NAMES, recordDuration } from "../lib/metrics";
import { chunkText } from "./chunker";
import { getOpenAICompatibleEmbedding } from "./providers/openai-compatible";
import {
	EmbeddingBatchError,
	type EmbeddingFailureCode,
	type EmbeddingResult,
} from "./result";
import type { EMBEDDING_DIMENSIONS } from "./utils";
import { embeddingProfileId, validateEmbeddingVector } from "./validation";

export { EmbeddingBatchError } from "./result";

function providerApiKey(baseUrl: string, explicitKey?: string): string {
	const providerKey = explicitKey?.trim();
	if (providerKey) return providerKey;

	// Only OpenRouter may inherit the shared public-profile credential. This
	// prevents accidentally forwarding it to Ollama or another local/custom
	// OpenAI-compatible endpoint when the base URL is overridden.
	if (!/openrouter\.ai/i.test(baseUrl)) return "";

	const openRouterKey = config.OPENROUTER_API_KEY?.trim();
	if (!openRouterKey) {
		throw new Error(
			"OpenRouter embedding provider requires OPENROUTER_API_KEY (or a provider-specific EMBEDDING_*_API_KEY)",
		);
	}
	return openRouterKey;
}

/**
 * Get an embedding result for a single text.
 * Tries the primary provider, then fallback, and reports failures as data.
 *
 * Observability: records a duration sample for every call and increments
 * one of `embedding_success` / `embedding_fallback` / `embedding_zero`
 * based on the outcome. Operators surface these via
 * `/api/admin/metrics`. The duration sample is recorded in a `finally`
 * block so an unexpected throw in the provider still produces a metric
 * sample (the counter increment is intentionally skipped on that path —
 * we don't want to mis-classify exceptions as zero-vector fallbacks).
 */
export async function getEmbedding(text: string): Promise<EmbeddingResult> {
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
async function getEmbeddingInner(text: string): Promise<EmbeddingResult> {
	const providers: Array<{
		baseUrl: string;
		apiKey?: string;
		model: string;
		provider: "primary" | "fallback";
	}> = [];
	if (config.EMBEDDING_BASE_URL && config.EMBEDDING_MODEL) {
		providers.push({
			baseUrl: config.EMBEDDING_BASE_URL,
			apiKey: config.EMBEDDING_API_KEY,
			model: config.EMBEDDING_MODEL,
			provider: "primary",
		});
	}
	if (config.EMBEDDING_FALLBACK_BASE_URL && config.EMBEDDING_FALLBACK_MODEL) {
		providers.push({
			baseUrl: config.EMBEDDING_FALLBACK_BASE_URL,
			apiKey: config.EMBEDDING_FALLBACK_API_KEY,
			model: config.EMBEDDING_FALLBACK_MODEL,
			provider: "fallback",
		});
	}

	if (providers.length === 0) {
		logger.warn(
			"No embedding provider configured (primary or fallback); embedding result is unavailable",
		);
		incrementCounter(METRIC_NAMES.EMBEDDING_ZERO);
		return { ok: false, code: "not_configured" };
	}

	let primaryError: string | undefined;
	let fallbackError: string | undefined;
	let finalCode: EmbeddingFailureCode = "provider_error";

	for (const provider of providers) {
		try {
			const vector = await getOpenAICompatibleEmbedding(
				text,
				provider.baseUrl,
				providerApiKey(provider.baseUrl, provider.apiKey),
				provider.model,
				config.EMBEDDING_TIMEOUT_MS,
			);
			const validation = validateEmbeddingVector(vector);
			if (!validation.ok) {
				finalCode = validation.code;
				const message = `provider returned ${validation.code}`;
				if (provider.provider === "primary") primaryError = message;
				else fallbackError = message;
				logger.warn(
					{
						model: provider.model,
						provider: provider.provider,
						code: validation.code,
					},
					"Embedding provider returned an invalid vector",
				);
				continue;
			}

			if (provider.provider === "primary") {
				incrementCounter(METRIC_NAMES.EMBEDDING_SUCCESS);
			} else {
				incrementCounter(METRIC_NAMES.EMBEDDING_FALLBACK);
			}
			return {
				ok: true,
				vector,
				model: provider.model,
				provider: provider.provider,
				dimensions: validation.dimensions,
				profile: embeddingProfileId(
					provider.model,
					validation.dimensions,
					"v1",
				),
			};
		} catch (err) {
			finalCode = failureCodeFromError(err);
			const message = safeErrorMessage(err);
			if (provider.provider === "primary") primaryError = message;
			else fallbackError = message;
			logger.warn(
				{ err, model: provider.model, provider: provider.provider },
				"Embedding provider failed, trying next configured provider",
			);
		}
	}

	incrementCounter(METRIC_NAMES.EMBEDDING_ZERO);
	return {
		ok: false,
		code: finalCode,
		...(primaryError ? { primaryError } : {}),
		...(fallbackError ? { fallbackError } : {}),
	};
}

function safeErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.length > 0) {
		return error.message.slice(0, 256);
	}
	return "provider error";
}

function failureCodeFromError(error: unknown): EmbeddingFailureCode {
	const message = safeErrorMessage(error).toLowerCase();
	if (message.includes("dimension")) return "wrong_dimensions";
	if (message.includes("finite") || message.includes("nan")) {
		return "non_finite";
	}
	if (message.includes("zero")) return "zero_vector";
	return "provider_error";
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
	model: string;
	profile: string;
	dimensions: typeof EMBEDDING_DIMENSIONS;
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
		return [];
	}

	const results: EmbeddingChunk[] = [];
	for (let i = 0; i < chunks.length; i += 5) {
		const batch = chunks.slice(i, i + 5);
		const batchEmbeddings = await Promise.all(
			batch.map(async (chunk, batchIndex) => {
				const result = await getEmbedding(chunk.text);
				if (!result.ok) {
					throw new EmbeddingBatchError(result.code, i + batchIndex);
				}
				return result;
			}),
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
				embedding: embedding.vector,
				charStart: chunk.charStart,
				charEnd: chunk.charEnd,
				model: embedding.model,
				profile: embedding.profile,
				dimensions: embedding.dimensions,
			});
		}
	}

	return results;
}
