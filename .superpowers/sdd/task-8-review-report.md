# Task 8 Review Follow-up Report

## Blockers fixed

- Search requests now pass page, limit, sort, folder, category, tag, and date filters into the search domain. The route no longer retrieves a first-100 page and filters it locally, so domain totals and pagination are computed after scoped filtering.
- Anonymous share search accepts `x-share-token` (and `x-share-password` when required), resolves the complete document allow-list through the share-link owner scope, and passes `GraphVisibilityScope.kind = "share"` with those IDs to GraphRAG. Missing, expired, mismatched, and unauthenticated access remains `401`.
- `includeChunks` embeds the query once, restricts rows to the active valid 1024-dimensional generation/profile, orders by cosine similarity, and returns at most three finite-scored chunks. Constant zero scores and index-order hydration were removed.
- Folder and tag metadata hydration is owner-scoped. Public documents cannot pull private folder or tag names from another owner, and share responses remain limited to the token allow-list.
- Added an injectable route/hydrator test path that verifies a non-empty result preserves vector/GraphRAG explanations and forwards global filters. The frontend `SearchResult.explanations` field is required and chunk metadata is typed.

## Verification

- Backend route/category/share/search/GraphRAG tests: 60 passed, 0 failed.
- Backend chunk helper and non-empty route contract: 38 passed, 0 failed.
- Frontend API/component tests: 10 passed, 0 failed.
- Frontend typecheck: passed with zero diagnostics.
- Backend typecheck: passed.
- Backend and frontend lint: passed.
- `git diff --check`: passed.

## Scope

GraphRAG remains automatic; legacy graph query fields are accepted only for the temporary deprecation header and do not control execution. No credentials, release tags, or pushes were changed.

## Final review follow-up

- The HTTP response now reports the count of authorized, hydrated public items. It never exposes `searchDocuments().total` when a candidate was removed during hydration or share allow-list enforcement.
- The orchestrator owns a request-scoped embedding promise cache. The vector channel, expanded retrieval, and `includeChunks` hydration reuse the same query embedding and therefore the same active profile; no second provider request is made for the original query.
- Folder/category filtering now joins folders with both `folder.id = document.folder_id` and `folder.owner_id = ctx.userId`, selects the joined owner, and applies a runtime owner check before using `folder.category_id`.
- Added regression coverage for the hydrated public count, embedding-provider call count and propagation, and cross-owner folder category rejection.

Focused verification after this follow-up:

- `bun test backend/tests/integration/routes.search.test.ts backend/tests/integration/routes.search-category.test.ts backend/tests/integration/search-retrievers.test.ts` — 43 passed, 0 failed.
- `bun test backend/src/__tests__/search-orchestrator.test.ts backend/src/__tests__/search-route-helpers.test.ts` — 12 passed, 0 failed.
- `cd backend && bun run typecheck` — passed.
- `cd backend && bun run lint` — passed.
- `git diff --check` — passed.
