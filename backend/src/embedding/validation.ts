import { EMBEDDING_DIMENSIONS } from "./utils";

export type EmbeddingValidationResult =
	| { ok: true; dimensions: typeof EMBEDDING_DIMENSIONS }
	| {
			ok: false;
			code: "zero_vector" | "wrong_dimensions" | "non_finite";
	  };

/** Validate the invariant required by pgvector-backed semantic search. */
export function validateEmbeddingVector(
	vector: number[],
): EmbeddingValidationResult {
	if (vector.length !== EMBEDDING_DIMENSIONS) {
		return { ok: false, code: "wrong_dimensions" };
	}
	if (!vector.every((value) => Number.isFinite(value))) {
		return { ok: false, code: "non_finite" };
	}
	if (!vector.some((value) => value !== 0)) {
		return { ok: false, code: "zero_vector" };
	}
	return { ok: true, dimensions: EMBEDDING_DIMENSIONS };
}

export function embeddingProfileId(
	model: string,
	dimensions: number = EMBEDDING_DIMENSIONS,
	normalizationVersion = "v1",
): string {
	return `${model}:${dimensions}:${normalizationVersion}`;
}
