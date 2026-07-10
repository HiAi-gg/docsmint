# Task 6 Report: Structured One-Pass Query Expansion

## Status

Implemented and ready for integration. Changes are committed in the task branch; no push was performed.

## Commit

- `b13001e feat(search): add adaptive multilingual query expansion`
- `dc9c330 refactor(search): consume shared query plan contract`

## Files changed

- `backend/src/lib/openai-compatible-chat.ts`
  - Added shared OpenAI-compatible JSON chat transport.
  - Supports primary/fallback providers, timeout cancellation, JSON/fenced-JSON parsing, Zod validation, and safe failure.
  - Shared OpenRouter credentials are resolved only for OpenRouter URLs; custom/local providers require explicit keys.
- `backend/src/search/query-expander.ts`
  - Added immutable `QueryPlan` expansion with one provider pass.
  - Added Ministral primary and Gemma fallback defaults.
  - Added deduplication, original-query removal, per-list caps, cache hashing, and tenant-scoped Redis keys.
- `backend/src/__tests__/query-expander.test.ts`
  - Covers Russian-to-English expansion, deduplication, query removal, list caps, malformed JSON, timeout fallback, total provider failure, and tenant-safe hashed keys.
- `backend/src/lib/graph/extract-entities.ts`
  - Refactored entity extraction to use the shared transport while preserving extraction parsing and AGE persistence.
  - Corrected same-endpoint/different-model fallback selection.
- `backend/src/lib/config-schema.ts`
  - Added adaptive expansion, RRF, fuzzy/vector thresholds, GraphRAG contribution, and seed-limit settings.
- `backend/src/__tests__/config.test.ts`
  - Added search-default and custom-provider schema coverage.
- `.env.example`
  - Added documented public search expansion and ranking profile with placeholder-only credentials.

## Verification

Passing:

```text
cd backend && bun test src/__tests__/query-expander.test.ts src/__tests__/graph-extract.test.ts src/__tests__/config.test.ts
38 pass, 0 fail

cd backend && bun run lint
Checked 95 files in 40ms. No fixes applied.
```

The focused `bun run typecheck` is currently blocked by concurrent Task 1 database-schema edits in the shared worktree: `backend/src/embedding/worker.ts` still inserts legacy embedding rows without the new required `generationId`. No database or worker files were changed by Task 6. Once Task 1/3 worker integration lands, rerun `cd backend && bun run typecheck`.

`git diff --check` passes for the Task 6 changes.

## Concerns for integration

- Task 4's `backend/src/search/types.ts` is now consumed directly by the expander; its `QueryPlan` fields must remain provider-independent.
- The runtime Redis singleton logs its expected connection warning when Redis is not running; cache failures are intentionally non-fatal.
- The public `.env.example` contains only the existing change-me OpenRouter placeholder and no real credential.

## Reviewer follow-up (2026-07-11)

Applied the Task 6 review corrections without changing schema, migration, worker,
or Task 4 files:

- `resolveChatProviderKey` now parses the URL and accepts the shared
  `OPENROUTER_API_KEY` only for the exact `openrouter.ai` or `www.openrouter.ai`
  hostnames. Invalid URLs, subdomain lookalikes, userinfo tricks, and path
  lookalikes receive no shared key. Explicit provider keys remain supported.
- Query expansion removes both `plan.original` and `plan.normalized` from all
  generated and cached variant lists using NFKC/case/whitespace normalization.
- `SEARCH_VECTOR_MIN_SIMILARITY` is constrained to `[0, 1]` with default `0.35`.
- Graph extraction no longer falls back to `EMBEDDING_API_KEY` or
  `EMBEDDING_FALLBACK_API_KEY`; custom/local graph endpoints require their
  dedicated `GRAPH_EXTRACT_*_API_KEY`, while exact OpenRouter hosts may use the
  shared key.
- Added resolver host-isolation coverage and original/normalized variant
  regression coverage. The query-expander test source contains no raw Cyrillic
  literals; Unicode escapes preserve the runtime test values.

Verification after the follow-up:

```text
cd backend && bun test src/__tests__/query-expander.test.ts src/__tests__/graph-extract.test.ts src/__tests__/config.test.ts src/__tests__/openai-compatible-chat.test.ts
42 pass, 0 fail, 134 expect() calls

cd backend && bunx biome check src/lib/openai-compatible-chat.ts src/search/query-expander.ts src/lib/config-schema.ts src/lib/graph/extract-entities.ts src/__tests__/query-expander.test.ts src/__tests__/openai-compatible-chat.test.ts src/__tests__/graph-extract.test.ts
Checked 7 files in 8ms. No fixes applied.

cd backend && git diff --check
passed
```

The focused backend typecheck still reports only the pre-existing Task 1
integration error in `src/embedding/worker.ts`: the insert payload is missing
the newly required `generationId`. No Task 6 file causes a type error, and no
worker or database file was modified here.
