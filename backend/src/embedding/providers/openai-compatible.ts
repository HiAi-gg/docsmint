/**
 * Generic OpenAI-compatible embedding provider.
 * Works with any service that exposes an OpenAI-style /embeddings endpoint
 * (OpenAI, OpenRouter, Voyage, local Ollama, etc.).
 */

import { logger } from "../../lib/logger";
import { EMBEDDING_DIMENSIONS, normalizeDimensions } from "../utils";

interface OpenAICompatibleEmbeddingResponse {
	data: Array<{ embedding: number[] }>;
}

/**
 * Get an embedding vector from any OpenAI-compatible API.
 * @param text - Text to embed
 * @param baseUrl - Base URL of the embeddings API (e.g. https://api.openai.com/v1)
 * @param apiKey - API key (omit or pass empty string for unauthenticated local servers)
 * @param model - Model name to use for embedding
 * @returns number[] of length 1024
 */
export async function getOpenAICompatibleEmbedding(
	text: string,
	baseUrl: string,
	apiKey: string,
	model: string,
	timeoutMs: number,
): Promise<number[]> {
	const url = `${baseUrl.replace(/\/$/, "")}/embeddings`;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}

	try {
		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({ model, input: text }),
			signal: controller.signal,
		});

		if (!response.ok) {
			const body = await response.text().catch(() => "unknown");
			throw new Error(
				`OpenAI-compatible embedding failed: ${response.status} ${body}`,
			);
		}

		const data = (await response.json()) as OpenAICompatibleEmbeddingResponse;
		const embedding = data.data?.[0]?.embedding;

		if (!Array.isArray(embedding) || embedding.length === 0) {
			throw new Error(
				"OpenAI-compatible provider returned empty or invalid embedding",
			);
		}

		return normalizeDimensions(embedding, EMBEDDING_DIMENSIONS);
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			logger.error(
				{ url, model },
				"OpenAI-compatible embedding request timed out",
			);
			throw new Error(
				`OpenAI-compatible embedding timed out after ${timeoutMs}ms`,
			);
		}
		logger.error({ err, url, model }, "OpenAI-compatible embedding error");
		throw err;
	} finally {
		clearTimeout(timeout);
	}
}
