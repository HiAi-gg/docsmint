# Task 8 Report: Search Route and Result Explanations

## Delivered

- Replaced route-local text/vector merge and AGE expansion with `searchDocuments()`.
- Kept HTTP concerns in the route: authentication, rate limiting, Zod validation, tenant-scoped display hydration, filters, sorting, pagination, tags, and optional chunk hydration.
- GraphRAG is automatic. Legacy `graph`, `graphHops`, and `graphBoost` inputs are ignored by the route and return a temporary `Deprecation: true` response header.
- Hydrated rows accept owner-visible documents and public GraphRAG documents while preserving the existing tenant boundary.
- Added the public `SearchExplanation` frontend type and renders at most three safe labels per result. Provider prompts, scores, tenant data, and relationship internals are not rendered.
- Kept one search input and no GraphRAG mode toggle.

## Verification

- Backend route/category tests: 39 passed, 0 failed.
- Frontend search/component tests: 10 passed, 0 failed.
- Backend typecheck: passed.
- Frontend typecheck: passed with zero diagnostics.
- Backend lint (`biome check src/`): passed.
- Frontend lint (`biome check src/`): passed.
- `git diff --check`: passed.

Browser smoke was not run in this isolated worktree because no app server was started; the component contract is covered by the focused static component test and Svelte typecheck. The parent release verification should run the approved agent-browser desktop/mobile smoke against the assembled app.

## Boundary note

The search domain remains the sole owner of retrieval, confidence gating, adaptive expansion, GraphRAG, and RRF ranking. The route is intentionally a serialization/data-scope adapter for the existing HTTP contract; it does not recompute relevance scores.
