import type { EMBEDDING_DIMENSIONS } from "./utils";

export type EmbeddingFailureCode =
	| "not_configured"
	| "provider_error"
	| "zero_vector"
	| "wrong_dimensions"
	| "non_finite";

export type EmbeddingResult =
	| {
			ok: true;
			vector: number[];
			model: string;
			provider: "primary" | "fallback";
			dimensions: typeof EMBEDDING_DIMENSIONS;
			profile: string;
	  }
	| {
			ok: false;
			code: EmbeddingFailureCode;
			primaryError?: string;
			fallbackError?: string;
	  };

/**
 * Safe error raised when a document cannot produce a complete embedding batch.
 * Only a stable failure code and chunk index are exposed to callers.
 */
export class EmbeddingBatchError extends Error {
	readonly code: EmbeddingFailureCode;
	readonly chunkIndex: number;

	constructor(code: EmbeddingFailureCode, chunkIndex: number) {
		super(`Embedding failed for chunk ${chunkIndex}: ${code}`);
		this.name = "EmbeddingBatchError";
		this.code = code;
		this.chunkIndex = chunkIndex;
	}
}
