/**
 * Actual production retrieval map (traced from source, not architecture prose).
 *
 * query
 *   → analyzeQuery (search/query-analyzer.ts)
 *   → retrieveFastChannels exact/FTS/fuzzy/vector (search/retrievers.ts)
 *       rankingWindow = page * limit, cap MAX_SEARCH_RANKING_WINDOW
 *   → evaluateConfidence (search/confidence.ts)
 *       if not confident: expandQuery original plan (search/query-expander.ts)
 *       then expanded_fts/fuzzy/vector via retrieveFastChannels on variants
 *   → fuseCandidates RRF (search/rrf.ts) on fast+expanded → graph seeds
 *   → retrieveGraphCandidates AGE (search/graph-retriever.ts)
 *   → fuseCandidates RRF on fast+expanded+graph
 *   → applySearchFilters
 *   → paginate
 *
 * Rerank (search/rerank.ts) runs after the retrieval RRF by default:
 *   SEARCH_RERANK_GRAPH_POSITION=after  → RRF(fast+expanded) → rerank → graph → append
 *   SEARCH_RERANK_GRAPH_POSITION=before → current second RRF including graph → rerank
 *   SEARCH_RERANK_ENABLED=false         → identical to the pre-rerank pipeline
 */
export const SEARCH_PIPELINE_FILES = {
	analyzer: "backend/src/search/query-analyzer.ts",
	retrievers: "backend/src/search/retrievers.ts",
	confidence: "backend/src/search/confidence.ts",
	expander: "backend/src/search/query-expander.ts",
	rrf: "backend/src/search/rrf.ts",
	graph: "backend/src/search/graph-retriever.ts",
	orchestrator: "backend/src/search/orchestrator.ts",
	rerank: "backend/src/search/rerank.ts",
	http: "backend/src/api/routes/search.ts",
} as const;
