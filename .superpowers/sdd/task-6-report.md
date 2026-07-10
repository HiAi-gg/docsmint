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
