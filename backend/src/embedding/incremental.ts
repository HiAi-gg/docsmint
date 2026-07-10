export interface StoredChunkState {
	chunkHash: string | null;
	embedding: number[] | null;
	embeddingModel: string | null;
}

/**
 * Decide whether a stored chunk must be replaced during incremental re-embed.
 * Content equality alone is insufficient: a prior provider failure may have
 * stored a zero vector, and model changes require a fresh vector even when the
 * chunk text did not change.
 */
export function needsChunkRefresh(
	stored: StoredChunkState | undefined,
	newHash: string,
	currentModel: string,
): boolean {
	if (!stored) return true;
	if (stored.chunkHash !== newHash) return true;
	if ((stored.embeddingModel ?? "") !== currentModel) return true;
	if (!stored.embedding || stored.embedding.length === 0) return true;
	return stored.embedding.every((value) => value === 0);
}
