# Task 3 Report: Atomic Embedding Generations

Status: DONE_WITH_CONCERNS

## Implementation

- Added the generation lifecycle helpers in `backend/src/embedding/generation.ts`.
- Added pending, processing, ready, failed, and stale transition validation.
- Refactored the worker to stage complete candidate generations, persist the actual producing model/profile/dimension for every row, copy unchanged valid chunks from the active generation, and activate only after all rows pass validation.
- Failed candidates are removed without touching the active generation. Graph extraction runs only after activation.
- Queueing now marks active documents stale and exposes profile-mismatch marking for targeted reindex.
- Reindex is resumable with ordered UUID cursors, `--after`, `--batch`, `--dry-run`, and JSON progress output. It never deletes embeddings.
- Admin embedding stats now include lifecycle counts, active invalid rows, inactive generations, profile mismatches, and pending age.

## Verification

```text
cd backend && bun run typecheck
PASS

cd backend && bun test src/__tests__/embedding-generation.test.ts
2 pass, 0 fail

cd backend && bun test src/__tests__/embedding-incremental.test.ts src/__tests__/embedding-metadata.test.ts src/__tests__/embedding-validation.test.ts
19 pass, 0 fail

cd backend && bunx biome check \
  src/embedding/generation.ts src/embedding/incremental.ts src/embedding/worker.ts \
  src/lib/embedding-queue.ts src/scripts/reindex-embeddings.ts src/api/routes/admin.ts
PASS
```

## Concerns

- The worker still computes provider embeddings for every newly chunked slice before persistence because `embedDocument()` owns chunking and provider batching. Persistence is incremental and copies unchanged vectors, but provider-call minimization should be completed when the chunker/provider API is split into a reusable changed-slice path.
- The integration state-machine tests use the existing in-memory transaction harness; a live PostgreSQL smoke remains a release-level check.
- Other task agents have uncommitted files in this shared worktree. The Task 3 commit stages only the files listed below.

## Review Fixes

Status: REVIEW_FIXED

The review blockers are resolved:

- `EmbeddingBatchError` is exported from the embedding entry point and imported from its defining result module by the worker.
- Nullable `activeEmbeddingGeneration` is narrowed into a local value before it is used in the incremental query.
- Worker catch blocks classify `unknown` errors through a safe allowlist and never persist arbitrary provider messages.
- Activation validates every staged row's validity, model, profile, and 1024 dimension. The guarded update requires the candidate to
  remain the document's pending generation and uses `RETURNING` before deleting older rows, so a superseded candidate cannot win.
- Transaction-backed integration tests prove that an invalid or incomplete generation B leaves active generation A untouched and that
  only a complete valid B switches the active generation.
- `enqueueEmbedding` now awaits the stale transition before pushing Redis work and guards the update by the generation observed in the
  same transaction, preventing a stale write from overwriting a newly-ready generation. It returns whether the queue push succeeded.
- Reindex awaits every enqueue and increments `queued` only for successful pushes. The scan explicitly covers null/legacy generation and
  profile fields, invalid/zero vectors, null/empty models, wrong dimensions, and primary or fallback profile mismatch.
- Incremental refresh now also replaces non-finite stored vectors.

Review-fix verification:

```text
cd backend && bun run typecheck
PASS

cd backend && bun test src/__tests__/embedding-generation.test.ts src/__tests__/embedding-incremental.test.ts src/__tests__/embedding-metadata.test.ts src/__tests__/embedding-validation.test.ts
24 pass, 0 fail

cd backend && bun test tests/integration/embedding-generation.test.ts
4 pass, 0 fail

cd backend && bun test src/__tests__/reembed.test.ts src/__tests__/reembed-cron.test.ts src/__tests__/routes.test.ts src/__tests__/metrics-route.test.ts
33 pass, 0 fail

cd backend && bunx biome check --write src/embedding/generation.ts src/embedding/worker.ts src/lib/embedding-queue.ts src/scripts/reindex-embeddings.ts tests/integration/embedding-generation.test.ts
PASS

git diff --check
PASS
```
