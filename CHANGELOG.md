# Changelog

All notable changes to hiai-docs are documented in this file.

<!-- Verified accurate for v0.1.1 by doc audit 2026-07-02 -->

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-07-02

### Performance

- **HNSW vector index now used in semantic search** — the inner query finds top-k chunks by vector distance (using the HNSW index), and the outer query joins + deduplicates. Previously, `ORDER BY d.id, distance` put the document ID first, preventing the planner from using the HNSW index. Fixes **G3** from the GraphRAG audit.
- **AGE search-expansion uses `client.unsafe()`** — Cypher queries in `search-expansion.ts` now use `client.unsafe()` with dollar-quoting instead of postgres-js bind parameters. Fixes **G7** from the GraphRAG audit.
- **Frontend Dockerfile optimization** — multi-stage Dockerfile now separates dependency stages from runtime, reducing final image size and attack surface. Fixes **Item 16** from the production audit.

### GraphRAG

- **AGE shared library auto-loading** — `postgres/init.sql` now adds `ALTER DATABASE current_database() SET session_preload_libraries = 'age'` to load the AGE library on every session. Remaining graph-discoverable issues tracked in GRAPHRAG_AUDIT.md.
- **Entity extraction refactored** — `extract-entities.ts` rewritten for cleaner error handling, Ollama-compatible endpoint path construction, and more robust entity parsing.
- **Graph migration `001_init.sql`** — updated with AGE library preloading and index improvements.

### Config & Security

- **Config schema hardening** — `BETTER_AUTH_SECRET`, `CSRF_SECRET`, and `WEBHOOK_SECRET` now have explicit `.min(1)` guards to reject empty strings in any environment, complementing the existing production-only `refine()` guards.
- **`docker-compose.yml` DB port default** — changed from `5433` to `5437` for consistency with `.env.example` and dev-compose. CSRF/WEBHOOK_SECRET now have `${:-default}` fallbacks in compose.

### Documentation

- **Full documentation audit sweep** — all documentation files updated to reflect v0.1.1+ reality:
  - Ports unified across AGENTS.md, design-spec.md, DEPLOYMENT.md, PRODUCTION_STATUS.md (DB: 5437, Redis: 6384, MinIO console: 9021, Caddy: 80/443).
  - Editor references updated from Tipex → svelte-tiptap + TipTap v3 in design-spec.md.
  - PRODUCTION_AUDIT.md fully translated from Russian to English; all 19 audit items annotated with resolution status.
  - GRAPHRAG_AUDIT.md banner added; G2 and G8 marked as fixed.
  - DEPLOYMENT.md gained full env var tables for GraphRAG, hybrid search, chunking, re-embed batch caps, and attachments; secret hygiene policy documented.
  - README.md added GraphRAG health caveat.
  - AGENTS.md Docker services table updated to reflect current images and ports; secret management rules confirmed.
  - CHANGELOG cross-check verified and confirmed.

### Changed

- **`backend/src/lib/config-schema.ts`** — added `.min(1)` guards to BETTER_AUTH_SECRET, CSRF_SECRET, WEBHOOK_SECRET.
- **`backend/src/api/routes/search.ts`** — `semanticSearch` now uses a two-stage query for HNSW index utilization.
- **`backend/src/lib/graph/extract-entities.ts`** — major refactoring for robustness and Ollama-compatible endpoints.
- **`backend/src/lib/graph/search-expansion.ts`** — switched to `client.unsafe()` for Cypher queries.
- **`docker-compose.yml`** — DB_PORT default 5437; CSRF/WEBHOOK_SECRET compose defaults; frontend Dockerfile updated.
- **`packages/db/src/schema.ts`** — schema refinements.
- **`postgres/init.sql`** — AGE session_preload_libraries added.
- **`backend/src/__tests__/config.test.ts`** — expanded test coverage for config schema.

## [0.1.1] - 2026-07-01

### Security & Config

- **Dependency pinning** — replaced all ~80 `"latest"` specifiers with pinned semver ranges across all package.json files. `bun.lock` is now checked into version control for reproducible builds.
- **Production hardening** — `docker-compose.yml` now defaults `NODE_ENV` to `production` (overridable via `${NODE_ENV:-production}`). All hardcoded config values (graph, chunk, batch params) are now `${VAR:-default}` parameterized at the compose level.
- **Secrets hygiene** — `.env.example` no longer contains real cryptographic secrets. All keys replaced with `change-me` placeholders and `# CHANGE-ME` comments.
- **Caddy auto-TLS** — port mapping changed from `50708:80`/`50709:443` to standard `80:80`/`443:443`. Custom Dockerfile builds Caddy with `caddy-ratelimit` module via xcaddy.
- **Config schema guards** — `CSRF_SECRET` and `WEBHOOK_SECRET` now have production-only `refine()` guards (like `BETTER_AUTH_SECRET`), rejecting default values in production.
- **Cookie compatibility** — explicit `"cookie": "^0.6.0"` dependency pinned in frontend for SvelteKit build compatibility.
- **Port alignment** — `scripts/health-check.sh` defaults corrected: `REDIS_PORT` → 6384, `DB_PORT` → 5437 (matching compose defaults).
- **CI registry fix** — Docker Hub push target is `vgalibov/hiai-docs` (the `hiai-gg/hiai-docs` registry does not exist yet on Docker Hub; `RELEASE_CHECKLIST.md` documents this as the working fallback until the `hiai-gg` org is created).
- **MinIO image pinning** — `minio/minio:latest` → `minio/minio:RELEASE.2025-06-26T16-23-29Z` in both compose files.

## [0.1.0] - 2026-06-28

### Highlights

- **Unified PostgreSQL image (`hiai-postgres:18-custom`)** — pgvector + pgvectorscale + Apache AGE now live in a **single** PostgreSQL 18 database. Replaces the previous split between `pgvector/pgvector:pg18` (port 5437) and `apache/age:release_PG18_1.7.0` (port 5438). The custom image is defined in `postgres/Dockerfile` and the migration is idempotent (`postgres/init.sql`).
- **pgvectorscale (StreamingDiskANN)** — vector index upgrades. The image now ships `vector 0.8.3`, `vectorscale 0.9.0`, and `age 1.7.0` together. Switching index access method is a one-line DDL change (`USING diskann (embedding vector_cosine_ops)`) for >100k row corpora. Binary quantization (`SbqCompression`) is enabled by default in the index build.
- **Simplified deployment** — no more `age-postgres` service, `age_pgdata` volume, or `AGE_DATABASE_URL` env var. `docker compose up -d` brings up one image, one volume, one connection string.

### Added

- `postgres/Dockerfile` — multi-stage build: `builder` (pgvector from source, pgvectorscale via cargo pgrx 0.16.1) → `age_src` (prebuilt Apache AGE binaries from `apache/age:release_PG18_1.7.0`) → runtime (`postgres:18.1` base). AGE 1.7.0 is built against PG 18.1, so we pin the runtime to the same major to keep the glibc ABI aligned.
- `postgres/init.sql` — installs `vector`, `vectorscale`, `age`, `pg_trgm`, creates the `docs_graph` property graph, and sets `search_path = ag_catalog, public` so application code can call `cypher('docs_graph', $$ ... $$)` without schema-qualifying.
- `idx_document_embeddings_diskann` — StreamingDiskANN index on `document_embeddings.embedding` with `SbqCompression`. Co-exists with the existing HNSW index; choose per workload.
- `backend/src/lib/db.ts` — exports the raw `client` (`postgres.Sql`) alongside the Drizzle wrapper, so `lib/graph/*` can call raw `cypher()` while everything else still uses the typed Drizzle API.
- `backend/src/lib/graph/init.ts` — rewritten to use the shared Drizzle client. The module-level AGE-specific connection pool and `closeGraph()` lifecycle are gone; the lazy `getGraphDb()` still memoizes the init result so the migration only runs once per process.

### Changed

- **`backend/src/lib/graph/extract-entities.ts`** and **`search-expansion.ts`** — removed the `if (!config.AGE_DATABASE_URL)` early-return guards. The shared client is always available, so graph code paths now run as long as `GRAPH_*_ENABLED` is true and the `age` extension is installed.
- **`backend/src/api/routes/admin.ts`** — `graph/stats` no longer branches on `AGE_DATABASE_URL`. It reports `available: false` only when `GRAPH_*_ENABLED` is false or `getGraphDb()` returns `null` (extension missing).
- **`backend/src/api/routes/admin.ts`** — fixed the Cypher `graph/stats` query that was quoting Cypher bodies with `'' ''` (illegal in a bun-tagged SQL template). Now uses `$$ ... $$` dollar-quoting, the form AGE accepts.
- **`docker-compose.yml`** — `age-postgres` service and `age_pgdata` volume removed. The `postgres` service now builds from `postgres/Dockerfile` (`build: { context: ./postgres }`) and exposes the unified image. The `api` service's `environment` block drops `AGE_DATABASE_URL` and the dead `AGE_DB_*` env vars and gains `AGE_DATABASE_URL` removed.
- **`Dockerfile.backend`** — copies `backend/src/lib/graph/migrations/001_init.sql` into the runtime image so the AGE migration can be found relative to `lib/graph/init.ts` in the compiled bundle.
- **`.env`** and **`.env.example`** — `AGE_DATABASE_URL`, `AGE_DB_PORT`, `AGE_DB_NAME` removed. The GraphRAG config block now documents the unified-DB layout.
- **`postgres/init.sql`** — the `ALTER DATABASE ... SET search_path` is no longer enough on its own; the script also issues a session-level `SET search_path = ag_catalog, public` so the very first `docker-entrypoint-initdb.d` invocation can call `create_graph()` and resolve `agtype` / `graphid_ops` without a `DROP EXTENSION` workaround.
- **`backend/src/__tests__/graph-init.test.ts`** — rewritten to assert the new contract (`getGraphDb` returns the shared client or `null`).
- **`backend/src/scripts/benchmark-graph.ts`** — updated the AGE-availability check message to reflect the unified-DB layout.

### Removed

- `docker-compose.dev.yml` / `docker-compose.yml` — `age-postgres` service, `age_pgdata` volume, and `AGE_DATABASE_URL` env propagation.
- `backend/src/lib/config.ts` — `AGE_DATABASE_URL` Zod field.
- `backend/src/lib/graph/init.ts` — `closeGraph()` and the `GraphSqlClient` re-export (callers now import `postgres.Sql` directly when they need the type).

### Migration notes

- The previous two-container layout (`pgvector/pgvector:pg18` + `apache/age:release_PG18_1.7.0`) is gone. Single volume `pgdata` now holds the unified database; restore from a pre-migration `pg_dump` is fine — the table schema is unchanged.
- For a fresh deployment, `docker compose up -d` will build the unified image, run the migrations, and seed the AGE graph automatically.
- If you are upgrading an existing deployment: `docker compose down`, `docker volume rm hiai-docs_pgdata hiai-docs_age_pgdata` (after backing up with `pg_dump`), then `docker compose up -d`. The 5438 port is no longer used.

## [v0.1.0] - 2025-06-28

### Highlights

- **Smart Re-embed System** — automatic vector refresh on metadata changes (tags, folders, categories) with Redis-deduplicated batch processing to prevent embedding storms
- **Incremental Chunk Updates** — hash-based chunk comparison ensures only changed content is re-embedded; overlap regions maintain semantic continuity
- **GraphRAG with Apache AGE** — optional entity extraction and graph-based search expansion for discovering related documents beyond vector similarity
- **Chunk Versioning** — `embedding_model` column tracks which model produced each vector, enabling targeted reindex operations when models change
- **Admin Tooling** — comprehensive `/api/admin/*` endpoints for reindexing, embedding stats, provider health checks, and AGE inventory queries
- **Security & Performance** — tenant scoping controls (`ADMIN_CROSS_TENANT`, `?ownerId=`) and batch caps prevent resource spikes

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
