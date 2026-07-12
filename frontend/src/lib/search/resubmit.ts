export interface SearchSubmissionState {
	submittedQuery: string;
	loadedQuery: string | null | undefined;
	currentPage: number;
}

export function normalizeSearchQuery(query: string): string {
	return query.trim();
}

/**
 * A navigation to the current URL is intentionally a no-op in SvelteKit. An
 * explicit submit of the already loaded first-page query therefore needs a
 * local request trigger instead of another navigation.
 */
export function shouldForceSearchResubmit({
	submittedQuery,
	loadedQuery,
	currentPage,
}: SearchSubmissionState): boolean {
	const normalizedQuery = normalizeSearchQuery(submittedQuery);
	return (
		normalizedQuery.length > 0 &&
		normalizedQuery === normalizeSearchQuery(loadedQuery ?? "") &&
		currentPage === 1
	);
}
