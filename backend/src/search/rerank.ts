import type { RankedSearchResult } from "./types";

export interface RerankCandidate {
	id: string;
	text: string;
	sourceRank?: number;
	rrfScore?: number;
}

export interface RerankHit {
	id: string;
	score: number;
	rank: number;
}

export interface RerankRequest {
	query: string;
	candidates: RerankCandidate[];
	topN?: number;
}

export interface RerankProviderResult {
	hits: RerankHit[];
	model: string;
}

export const DEFAULT_RERANK_MAX_CHARS = 1_500;

/** Truncate candidate text without sending binary/data-URI payloads. */
export function normalizeRerankText(
	title: string,
	content: string,
	maxChars = DEFAULT_RERANK_MAX_CHARS,
): string {
	const cleaned = `${title.trim()}\n${content}`
		.replace(/data:[^\s)>]+/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length <= maxChars) return cleaned;
	return cleaned.slice(0, maxChars);
}

/**
 * Reorder the top-N ranked documents using provider hits. Unknown IDs and
 * missing hits keep the original RRF relative order after the reranked prefix.
 */
export function applyRerankOrder(
	ranked: RankedSearchResult[],
	hits: RerankHit[],
	topN: number,
): RankedSearchResult[] {
	if (ranked.length === 0 || hits.length === 0 || topN < 1) return ranked;
	const window = ranked.slice(0, Math.min(topN, ranked.length));
	const rest = ranked.slice(window.length);
	const byId = new Map(window.map((item) => [item.documentId, item]));
	const seen = new Set<string>();
	const reordered: RankedSearchResult[] = [];
	const sortedHits = [...hits].sort((left, right) => {
		if (right.score !== left.score) return right.score - left.score;
		return left.rank - right.rank;
	});
	for (const hit of sortedHits) {
		const item = byId.get(hit.id);
		if (!item || seen.has(hit.id)) continue;
		seen.add(hit.id);
		reordered.push(item);
	}
	for (const item of window) {
		if (seen.has(item.documentId)) continue;
		reordered.push(item);
	}
	return [...reordered, ...rest];
}
