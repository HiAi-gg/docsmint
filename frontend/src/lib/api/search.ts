import { apiFetch } from "$lib/api/client";

// --- Types -------------------------------------------------------------------

export interface SearchExplanation {
	channel:
		| "exact"
		| "fts"
		| "fuzzy"
		| "vector"
		| "expanded_fts"
		| "expanded_fuzzy"
		| "expanded_vector"
		| "graph";
	label: string;
	queryVariant?: string;
}

export interface SearchResult {
	id: string;
	title: string;
	snippet: string;
	score: number;
	folder_id: string | null;
	folder_name?: string | null;
	created_at: string;
	updated_at: string;
	explanations: SearchExplanation[];
	tags?: Array<{ id: string; name: string; color: string | null }>;
	chunks?: Array<{
		chunkIndex: number;
		chunkText: string;
		charStart: number;
		charEnd: number;
		score: number;
	}>;
}

export interface SearchResponse {
	items: SearchResult[];
	total: number;
	page: number;
	limit: number;
}

export interface SearchSuggestion {
	id: string;
	title: string;
	score: number;
}

export interface FilterOptions {
	folders: string[];
	tags: Array<{ id: string; name: string; color: string | null }>;
	categories: Array<{ id: string; name: string }>;
}

// --- Public API --------------------------------------------------------------

export type SearchSort =
	| "relevance"
	| "date_desc"
	| "date_asc"
	| "name_asc"
	| "name_desc";

/**
 * Adaptive multilingual search. GraphRAG is selected automatically by the
 * backend when it improves confidence; callers do not pass a graph toggle.
 *
 * `category` is an optional UUID that, when supplied, narrows results to
 * documents whose own `category_id` matches OR whose folder's
 * `category_id` matches. The two scopes are unioned by the backend so a
 * single category can classify both direct documents and folder members.
 */
export async function search(
	query: string,
	page = 1,
	limit = 20,
	sort: SearchSort = "relevance",
	filters?: {
		folder?: string;
		tags?: string[];
		category?: string;
		dateFrom?: string;
		dateTo?: string;
	},
): Promise<SearchResponse> {
	if (!query.trim()) {
		return { items: [], total: 0, page: 1, limit };
	}
	const params = new URLSearchParams({
		q: query,
		page: String(page),
		limit: String(limit),
	});
	if (sort !== "relevance") params.set("sort", sort);
	if (filters?.folder) params.set("folder", filters.folder);
	if (filters?.tags && filters.tags.length > 0)
		params.set("tags", filters.tags.join(","));
	if (filters?.category) params.set("category", filters.category);
	if (filters?.dateFrom) params.set("dateFrom", filters.dateFrom);
	if (filters?.dateTo) params.set("dateTo", filters.dateTo);
	// Adaptive search may spend a bounded vector budget followed by query
	// expansion. Keep this above the backend's default combined budget while
	// leaving the global API timeout unchanged for ordinary CRUD requests.
	return apiFetch(`/api/search?${params}`, { timeout: 15_000 });
}

/**
 * Quick title-only search for autocomplete / suggestions.
 * Returns top 5 matches.
 */
export async function searchSuggest(
	query: string,
): Promise<SearchSuggestion[]> {
	if (!query.trim()) return [];
	const params = new URLSearchParams({ q: query });
	return apiFetch(`/api/search/suggest?${params}`);
}

/**
 * Get available filter options (folders, tags, and categories for the
 * current user). Each call returns the bare minimum needed by the search
 * sidebar — a missing endpoint does not break the others; an empty list is
 * returned in that case so the sidebar section simply renders nothing.
 */
export async function getFilterOptions(): Promise<FilterOptions> {
	const [foldersRes, tagsRes, categoriesRes] = await Promise.allSettled([
		apiFetch<Array<{ id: string; name: string }>>("/api/folders"),
		apiFetch<Array<{ id: string; name: string; color: string | null }>>(
			"/api/tags",
		),
		apiFetch<Array<{ id: string; name: string }>>("/api/categories"),
	]);
	return {
		folders:
			foldersRes.status === "fulfilled"
				? foldersRes.value.map((f) => f.name)
				: [],
		tags: tagsRes.status === "fulfilled" ? tagsRes.value : [],
		categories: categoriesRes.status === "fulfilled" ? categoriesRes.value : [],
	};
}

// --- Text helpers (exported for component use) ------------------------------

/** Strip existing <mark> tags from a string. */
export function stripMarks(html: string): string {
	return html.replace(/<\/?mark>/g, "");
}

/** Wrap occurrences of query terms in <mark> tags. */
export function highlightTerms(text: string, query: string): string {
	if (!query.trim()) return text;

	const terms = query
		.split(/\s+/)
		.filter(Boolean)
		.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

	if (terms.length === 0) return text;

	const regex = new RegExp(`(${terms.join("|")})`, "gi");
	return text.replace(regex, "<mark>$1</mark>");
}
