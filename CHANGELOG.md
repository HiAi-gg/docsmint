# Changelog

All notable changes to hiai-docs are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`document_embeddings.embedding_model` column** (migration `0006_embedding_model_column.sql`). Records which model produced each vector and is indexed for fast targeted reindex. Existing rows default to `""` (model unknown) and are treated as candidates for reindex once a model is configured.
- **`POST /api/admin/reindex/model?dryRun=true`** — targeted re-embed for documents whose stored `embedding_model` does not match the currently configured `EMBEDDING_MODEL`. After upgrading embedding model, run with `?dryRun=true` first to preview the affected count, then commit with `?dryRun=false`.
- **`GET /api/admin/graph/stats`** — Apache AGE inventory (node and edge counts). Returns `{ available: false, reason: "..." }` when GraphRAG is disabled or unreachable.
- **`POST /api/admin/reindex/folder/:folderId?dryRun=true`** — bulk re-embed every document in a folder (operator-scoped, bypasses per-user filter).
- **`POST /api/admin/reindex/tag/:tagId?dryRun=true`** — bulk re-embed every document carrying a tag.
- **Search query parameters**: `graph` (boolean, default `false`), `graphHops` (1-3, default `2`), `graphBoost` (0-2, default = `GRAPH_EXPANSION_BOOST`). `graph=true` is a no-op when `GRAPH_SEARCH_ENABLED=false`.
- **New environment variables**:
  - `FOLDER_REEMBED_BATCH_SIZE` (default `100`)
  - `CATEGORY_REEMBED_BATCH_SIZE` (default `100`)
  - `TAG_REEMBED_BATCH_SIZE` (default `500`)
  - `GRAPH_EXPANSION_BOOST` (default `0.3`)
  - `GRAPH_EXTRACT_ENABLED` (default `false`)
  - `GRAPH_SEARCH_ENABLED` (default `false`)
  - `GRAPH_EXTRACT_MODEL`, `GRAPH_EXTRACT_BASE_URL`, `GRAPH_EXTRACT_API_KEY`
  - `GRAPH_EXTRACT_FALLBACK_BASE_URL`, `GRAPH_EXTRACT_FALLBACK_API_KEY`, `GRAPH_EXTRACT_FALLBACK_MODEL`
  - `GRAPH_EXTRACT_MIN_CONFIDENCE` (default `0.5`)
  - `AGE_DATABASE_URL` (optional)
  - `HYBRID_TEXT_WEIGHT` (default `0.4`)
  - `HYBRID_SEMANTIC_WEIGHT` (default `0.6`)
  - `CHUNK_TARGET_TOKENS` (default `500`)
  - `CHUNK_OVERLAP_TOKENS` (default `50`)
- **`backend/src/lib/reembed.ts`** — shared re-embed helper (`enqueueReembed`, `reembedDocsInFolder`, `reembedDocsInCategory`, `reembedDocsByTag`) used by every metadata-triggered path. Coalesces rapid PATCH / toggle storms via a Redis `SET NX EX 5` dedup slot.
- **`reembedDocsInFolderAdmin(folderId)`** in `backend/src/lib/reembed.ts` — operator-scope variant of `reembedDocsInFolder` that does not filter by `owner_id`. Used by the admin folder reindex endpoint so cross-user reindex actually fires.
- **Unit tests** at `backend/src/__tests__/reembed.test.ts` covering dedup semantics, Redis SET-NX behavior, best-effort fallback when Redis is unavailable, and a smoke test for `reembedDocsInFolderAdmin`.

### Changed

- **Re-embed on metadata changes is now system-wide.** Tag rename, tag delete, category rename, category delete, folder delete — all trigger a re-embed of every affected document through the shared helper. Previously several of these paths silently left stale embeddings that referenced old metadata names in their preamble.
- The embedding worker now writes `embeddingModel: config.EMBEDDING_MODEL ?? ""` on every new chunk row, so subsequent targeted reindex has a precise signal. The local `rows` type annotation in the worker transaction includes `embeddingModel: string` to match.
- `PATCH /api/documents/:id` re-embed path uses `enqueueReembed` (with Redis SET-NX dedup) instead of going straight to `enqueueEmbedding`. A rapid PATCH storm on the same document now coalesces into a single worker tick.
- GraphRAG expansion boost is sourced from `config.GRAPH_EXPANSION_BOOST` (env-tunable, default `0.3`) instead of a hard-coded constant. Per-request overrides via `?graphBoost=N` remain supported.
- `reembedDocsInCategory` unions documents directly attached to the category AND documents in folders attached to the category, because the embedding preamble resolves category name from either path. The `CATEGORY_REEMBED_BATCH_SIZE` cap applies to the merged set.

### Fixed

- **B-1** — category rename left stale embeddings referencing the old category name. Now triggers re-embed via the shared helper.
- **B-2** — category delete left stale embeddings. Now triggers re-embed via the shared helper.
- **B-3** — folder delete left stale embeddings. Now triggers re-embed via the shared helper.
- **B-5** — tag rename left stale embeddings (the prior "Wave 1b" claim was never merged into HEAD). Now triggers re-embed via the shared helper.
- **B-6** — tag delete left stale embeddings. Now triggers re-embed via the shared helper.
- **B-7** — `POST /api/admin/reindex/folder/:folderId` (non-`dryRun` branch) passed an empty `owner_id` to the user-scoped `reembedDocsInFolder(folderId, ownerId)` helper, which matched zero documents and queued nothing — a silent failure with HTTP 200 and `{ success: true, affected: 0 }`. Fixed by adding a dedicated operator-scope helper `reembedDocsInFolderAdmin(folderId)` in `backend/src/lib/reembed.ts` that bypasses the `owner_id` filter and re-uses the same batch cap + Redis dedup semantics.

### Removed

- Local `reembedDocumentsInFolder` helper in `backend/src/api/routes/folders.ts` — superseded by the shared `reembedDocsInFolder` in `backend/src/lib/reembed.ts`.

### Migration notes

- Apply `packages/db/src/migrations/0006_embedding_model_column.sql` (idempotent — `ADD COLUMN ... DEFAULT '' NOT NULL` is safe on populated tables).
- After changing `EMBEDDING_MODEL` in `.env` and restarting the API, run `POST /api/admin/reindex/model?dryRun=true` to preview affected docs, then commit with `dryRun=false` (or omit the flag).
- Operators who relied on tag / category / folder mutations NOT triggering re-embed will see new behavior — this is intentional, but the batch caps (`*_REEMBED_BATCH_SIZE`) keep the per-tick cost bounded.
- After upgrading to this release, `POST /api/admin/reindex/folder/:folderId?dryRun=false` finally enqueues documents as the API surface advertises. Operators who worked around the previous silent failure by using `POST /api/admin/reindex/model` directly can switch back to the folder-scoped endpoint.

### Validation status at close

- `tsc --noEmit` clean across all touched packages (and across `reembed.ts`, `admin.ts`, `worker.ts`, `reembed.test.ts` in particular).
- One pre-existing error remains in `backend/src/lib/graph/extract-entities.ts(585,1)` — a stray `\t` literal that pre-dates this work. Tracked separately.
- `bun test` not executed in the development environment (no Bun runtime available); run locally before commit.
