export interface EmbeddingGenerationRowState {
	activeGenerationId: string | null;
	candidateGenerationId?: string | null;
	rowGenerationId: string;
	documentProfile: string | null;
	rowProfile: string | null;
	rowDimensions: number;
	rowValid: boolean;
}

/** Search eligibility depends on the active generation, never candidate status. */
export function hasSearchableActiveGeneration(
	state: EmbeddingGenerationRowState,
): boolean {
	return (
		state.activeGenerationId !== null &&
		state.rowGenerationId === state.activeGenerationId &&
		state.rowGenerationId !== state.candidateGenerationId &&
		state.rowValid &&
		state.rowDimensions === 1024 &&
		state.documentProfile !== null &&
		state.rowProfile === state.documentProfile
	);
}
