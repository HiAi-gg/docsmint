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
- Integration state-machine tests require a live migrated PostgreSQL database; the focused local suite covers the transition contract and incremental behavior without mutating the shared database.
- Other task agents have uncommitted files in this shared worktree. The Task 3 commit stages only the files listed below.
