# Task 2 Report: Explicit and Validated Embedding Outcomes

Status: DONE_WITH_CONCERNS

## Scope

Implemented the embedding provider result contract requested by Task 2:

- explicit `EmbeddingResult` success/failure union;
- stable `EmbeddingFailureCode` values;
- 1024-dimension, finite, non-zero vector validation;
- model/dimension/normalization profile identifiers;
- primary and fallback validation with no fabricated zero-vector success;
- safe `EmbeddingBatchError` for failed document chunks;
- model, profile, and dimensions on every successful `EmbeddingChunk`;
- minimal search/admin call-site adaptation to the new result contract.

Task 3 remains the owner of generation activation and worker persistence changes.

## Commit

- Implementation commit: `fix(embedding): reject invalid provider vectors`.

## Files changed

- `backend/src/embedding/result.ts`
- `backend/src/embedding/validation.ts`
- `backend/src/embedding/index.ts`
- `backend/src/__tests__/embedding-validation.test.ts`
- `backend/src/__tests__/embedding.test.ts`
- `backend/src/__tests__/openai-compatible-embedding.test.ts`
- `backend/src/__tests__/embedding-metadata.test.ts`
- `backend/src/api/routes/search.ts`
- `backend/src/api/routes/admin.ts`

## Implementation

`getEmbedding(text)` now returns a discriminated result:

- success includes the validated vector, producing model, provider role, literal dimension `1024`, and `model:1024:v1` profile;
- failure includes a stable code such as `not_configured`, `provider_error`, `zero_vector`, `wrong_dimensions`, or `non_finite`;
- primary provider transport failures and invalid vectors are retried through the configured fallback;
- a final failure increments the existing zero/invalid metric for compatibility until the metrics rename task lands;
- no failure path returns a zero vector.

`embedDocument` rejects incomplete batches with `EmbeddingBatchError`, exposing only the safe failure code and chunk index. Empty chunk sets return an empty array instead of a fabricated vector.

The search route skips semantic and include-chunk vector work when the result is not successful. The admin health probe reports the explicit failure code and never interprets failure as a valid zero vector.

## Verification

Focused tests:

```text
$ cd backend
$ bun test src/__tests__/embedding-validation.test.ts src/__tests__/embedding.test.ts src/__tests__/openai-compatible-embedding.test.ts src/__tests__/embedding-metadata.test.ts
26 pass
0 fail
36 expect() calls
```

Focused Biome check:

```text
$ backend/node_modules/.bin/biome check \
  src/embedding/result.ts src/embedding/validation.ts src/embedding/index.ts \
  src/api/routes/search.ts src/api/routes/admin.ts \
  src/__tests__/embedding-validation.test.ts src/__tests__/embedding.test.ts \
  src/__tests__/embedding-metadata.test.ts
Checked 8 files in 11ms. No fixes applied.
```

`git diff --check` passed.

## Concerns and handoff

The backend-wide `bun run typecheck` reaches the existing Task 1 generation schema mismatch in `backend/src/embedding/worker.ts`: inserts now require `document_embeddings.generation_id`, but Task 3 owns generation-aware worker activation. No worker generation implementation was added here to avoid overlapping that task.

Task 3 should consume `EmbeddingChunk.model`/`profile` and assign the active generation, and should preserve the explicit failure semantics when marking document lifecycle state.
