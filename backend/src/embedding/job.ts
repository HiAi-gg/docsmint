export interface EmbeddingJob {
	documentId: string;
	attempt: number;
}

export const MAX_EMBEDDING_ATTEMPTS = 3;
export const EMBEDDING_RETRY_DELAYS_MS = [1_000, 5_000] as const;

export function decodeEmbeddingJob(raw: string): EmbeddingJob {
	try {
		const value = JSON.parse(raw) as Partial<EmbeddingJob>;
		if (
			typeof value.documentId === "string" &&
			value.documentId.length > 0 &&
			Number.isInteger(value.attempt) &&
			(value.attempt ?? -1) >= 0
		) {
			return { documentId: value.documentId, attempt: value.attempt ?? 0 };
		}
	} catch {
		// Legacy queue entries are plain document ids.
	}
	return { documentId: raw, attempt: 0 };
}

export function encodeEmbeddingJob(job: EmbeddingJob): string {
	return JSON.stringify(job);
}

export function retryDelayMs(attempt: number): number | null {
	if (attempt >= MAX_EMBEDDING_ATTEMPTS - 1) return null;
	return EMBEDDING_RETRY_DELAYS_MS[attempt] ?? null;
}
