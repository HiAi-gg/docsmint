import { sql } from "drizzle-orm";
import { EMBEDDING_DIMENSIONS } from "./utils";

/** Smallest vector norm considered meaningful by storage and retrieval. */
export const EMBEDDING_NORM_EPSILON = 1e-9;

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
	if (vectorNorm(vector) <= EMBEDDING_NORM_EPSILON) {
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

/** Cosine similarity is undefined for zero or effectively-zero vectors. */
export function cosineSimilarity(left: number[], right: number[]): number {
	const leftNorm = vectorNorm(left);
	const rightNorm = vectorNorm(right);
	const denominator = leftNorm * rightNorm;
	if (!Number.isFinite(denominator) || denominator <= EMBEDDING_NORM_EPSILON)
		return 0;
	const dot = left.reduce(
		(sum, value, index) => sum + value * (right[index] ?? 0),
		0,
	);
	return Number.isFinite(dot) ? dot / denominator : 0;
}

function vectorNorm(vector: number[]): number {
	const squared = vector.reduce((sum, value) => sum + value * value, 0);
	return Number.isFinite(squared) && squared >= 0 ? Math.sqrt(squared) : 0;
}

/** SQL aggregates used by operator health to distinguish invalid vector rows. */
export function embeddingHealthStatColumns(embedding: unknown) {
	return {
		nullChunks: sql<number>`SUM(CASE WHEN ${embedding} IS NULL THEN 1 ELSE 0 END)::int`,
		zeroChunks: sql<number>`SUM(CASE WHEN ${embedding} IS NOT NULL AND vector_norm(${embedding}) = 0 THEN 1 ELSE 0 END)::int`,
		nearZeroChunks: sql<number>`SUM(CASE WHEN ${embedding} IS NOT NULL AND vector_norm(${embedding}) > 0 AND vector_norm(${embedding}) <= ${EMBEDDING_NORM_EPSILON} THEN 1 ELSE 0 END)::int`,
		emptyChunks: sql<number>`SUM(CASE WHEN ${embedding} IS NULL OR vector_norm(${embedding}) <= ${EMBEDDING_NORM_EPSILON} THEN 1 ELSE 0 END)::int`,
	};
}
