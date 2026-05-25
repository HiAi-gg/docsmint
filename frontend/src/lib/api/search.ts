import { apiFetch } from "$lib/api/client";

// --- Types -------------------------------------------------------------------

export interface SearchResult {
  id: string;
  title: string;
  snippet: string;
  score: number;
  folder_id: string | null;
  created_at: string;
  updated_at: string;
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
  tags: string[];
}

// --- Public API --------------------------------------------------------------

/**
 * Full hybrid search (text + semantic).
 */
export async function search(
  query: string,
  page = 1,
  limit = 20,
): Promise<SearchResponse> {
  if (!query.trim()) {
    return { items: [], total: 0, page: 1, limit };
  }
  const params = new URLSearchParams({ q: query, page: String(page), limit: String(limit) });
  return apiFetch(`/api/search?${params}`);
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
 * Get available filter options (folders and tags for the current user).
 */
export async function getFilterOptions(): Promise<FilterOptions> {
  try {
    const [folders, tags] = await Promise.all([
      apiFetch<Array<{ id: string; name: string }>>("/api/folders"),
      apiFetch<Array<{ id: string; name: string }>>("/api/tags"),
    ]);
    return {
      folders: folders.map((f) => f.name),
      tags: tags.map((t) => t.name),
    };
  } catch {
    return { folders: [], tags: [] };
  }
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
