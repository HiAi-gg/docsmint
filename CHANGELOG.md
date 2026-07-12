# Changelog

All notable changes to hiai-docs are documented in this file.

<!-- v0.2.8 candidate evidence verified 2026-07-12; publication remains a separate release action. -->

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.8] - 2026-07-12

### Added
- Global owner-wide and category-bound API keys with an explicit, non-hierarchical `read` / `edit` / `write` authorization matrix across documents, folders, search, graph, versions, attachments, tags, sharing, and visibility.
- SDK coverage for category/folder placement, document pipeline status, publish/unpublish, attachment presign/confirm, and session-backed API-key lifecycle operations.
- BullMQ document-processing pipeline with independent prepare, embed, graph,
  summarize, and finalize workers. PostgreSQL is
  the durable source of truth for nonterminal runs while Redis remains the job
  transport.
- One-release legacy embedding-queue bridge documentation and deterministic
  prepare-job migration checks.

### Changed
- API-key lifecycle routes now require a real Better Auth browser session. Global raw secrets remain one-time; category secrets are encrypted at rest and recoverable only by the owning session.
- CLI configuration enforces `0700` directory and `0600` file permissions on POSIX systems; CLI and MCP route contracts and public `bunx` invocation are aligned with the published package.
- Admin and metrics authentication accepts both `x-api-key` and Bearer forms and fails closed when the operator key is unset.
- Release verification now includes worker restart, Redis-loss reconciliation,
  owner isolation, and rollback safety checks.
- Worker scheduling now applies per-owner fairness, bounded per-document fan-out,
  provider concurrency controls, deterministic retry-safe job identifiers, and
  automatic reconciliation after restart.
- The canonical local runtime uses API port `50700` and web port `50701` across
  quickstart, release verification, and browser acceptance instructions.

### Fixed
- TipTap image insertion and resizing now trigger autosave, persist dimensions, and preserve them in shared/PDF and Markdown rendering; rich Markdown export retains images, tables, and legacy table content.
- Editor image resizing uses responsive bounds and persisted width/height attributes, while share rendering and document export keep the selected dimensions.
- The deprecated storage webhook is documented as an inbound signed no-op; false outbound lifecycle-webhook and storage-synchronization claims were removed.
- SvelteKit's production request-body limit now matches the documented import
  contour, allowing requests up to 100 MB to reach the backend while retaining
  the backend's 10 MB per-file limit.
- Pipeline migrations place state tables and enum types in `public`, repair
  objects created under the AGE search path during an earlier candidate run,
  and grant the runtime role only the required access.
- Empty documents and optional graph/summarization failures reach deterministic
  terminal states without blocking usable embeddings.

### Migration Notes
- Apply the complete Drizzle journal (`0000–0030`) before starting the API.
  Migration `0030` safely repairs pipeline objects created under the AGE schema
  by an earlier unreleased candidate.
- The verified candidate passed fresh-database and upgraded-database migration
  checks while preserving legacy documents and 1024-dimensional embeddings.
- Tagging, pushing, npm/Docker publication, and the GitHub Release remain
  explicit release actions after CI and operator browser acceptance.

## [0.2.7] - 2026-07-11

### Added
- **Adaptive multilingual search**: exact/title, multilingual lexical, fuzzy,
  vector, one-pass query expansion, and automatic GraphRAG retrieval are
  combined with reciprocal rank fusion (RRF).
- **Search explanations and chunks**: results expose bounded channel and graph
  contribution metadata, with request-scoped chunk hydration for authorized
  documents.
- **Generation-aware embeddings**: embedding generations use explicit
  pending/processing/ready/failed/stale states and atomic activation, while
  enforcing finite, non-zero 1024-dimensional vectors.
- **Relevance benchmark and observability**: the release contour includes
  tenant-scoped benchmark credentials, latency/relevance gates, and bounded
  search metrics without credentials in process arguments.

### Fixed
- **GraphRAG safety**: graph seeds are visibility-authorized before traversal,
  Cypher inputs use safe dollar-quoted values, and graph failures degrade to
  direct search results without leaking tenant data.
- **Share and pagination scope**: public/share search preserves document
  visibility while hydrating global authorized totals and page slices correctly.
- **Embedding test isolation**: provider tests no longer inherit process-global
  integration mocks, keeping the full suite deterministic.

### Migration Notes
- Apply the complete Drizzle journal (`0000–0026`) before enabling search
  generations or reindexing embeddings. The reference PostgreSQL image includes
  AGE and vector extensions required by the migrations.
- This candidate has passed fresh-database, upgraded-database, and live GraphRAG
  verification. Tagging and publication remain explicit release actions.

## [0.2.6] - 2026-07-10

### Fixed
- **Public share attachments**: protected document images are fetched with the share token and rendered through revocable blob URLs instead of anonymous raw URLs that returned `401`.
- **Public rich-text rendering**: paragraph/heading alignment, bullet lists, ordered-list start values, and task lists now share one tested ProseMirror renderer. Invalid block nodes from older imports are flattened inside headings instead of producing browser-rewritten HTML.
- **Public share hardening**: Markdown fallback and export HTML now pass through the same escaped renderer, and unsafe link protocols are rejected.
- **Audit RLS**: audit events are inserted inside a tenant transaction. Migration `0020_fix_audit_log_rls.sql` permits actors to append their own events, restricts reads to admins, and keeps update/delete unavailable.
- **SeaweedFS runtime**: production and development Compose files now generate the supported S3 identity configuration, use the filer health endpoint, and keep application traffic on the non-superuser `hiai_app` database role.
- **Attachment streaming**: async-iterable S3 bodies are consumed before AWS transform helpers, avoiding Bun runtime incompatibilities.
- **Release stability**: the metrics route test no longer binds an ephemeral host port, category API-access validation matches the current contract, and the session schema includes the already-migrated revocation fields.

### Changed
- Version synchronized to `0.2.6` across all workspace packages, the public package manifest, Swagger, OpenAPI, and release metadata.

### Migration Notes
- Run `bun run db:migrate` after upgrade to apply migration `0020_fix_audit_log_rls.sql`.

## [0.2.5] - 2026-07-09

### Fixed
- **Attachments raw streaming**: the `GET /api/attachments/:id/raw` route now reads SeaweedFS/S3 bodies through a runtime-agnostic body reader, so it handles both WHATWG streams and async-iterable S3 bodies during raw attachment downloads and integrity probes.
- **Editor toolbar list/alignment**: list toggles now fall back cleanly when the current TipTap command surface differs, and left alignment clears text alignment through `unsetTextAlign()` when available.
- **DOCX serializer**: paragraph/heading alignment handling is tightened and the serializer no longer relies on loose `any` typing for the local node/mark helpers.
- **Sidebar share actions**: folder and document menus now open the share dialog from the sidebar, with share state wired through the tree component.

### Changed
- Version bumped from `0.2.4` to `0.2.5` across workspace manifests, `package.public.json`, Swagger/OpenAPI, and production status metadata.

## [0.2.4] - 2026-07-08

### Fixed
- **package.public.json — broken export paths**: Three new v0.2.3 exports (`./backend/lib/rate-limit`, `./backend/lib/api-keys`, `./backend/lib/audit`) used `backend/...` paths missing the `./` prefix. Published package would fail to resolve these imports. Paths corrected to `./backend/...` to match all other exports.
- **docs/API.md — API keys mismatch**: Documented `expiresIn` duration field, but code uses `expiresAt` ISO 8601 datetime. Docs updated to match actual code behaviour.
- **docs/API.md — plugins response shape mismatch**: Documented `displayName`/`enabled` fields that do not exist in the `PluginManifest` type. Actual shape is `name`/`version`/`description`. Docs updated to match code.
- **docs/PRODUCTION_STATUS.md — route count**: Stale count of 14 route files. Actual count is 17 (added keys, plugins, visibility in v0.2.3). Corrected.

### Changed
- Version bumped from `0.2.3` to `0.2.4` across all workspace manifests: root `package.json`, `package.public.json`, `backend/package.json`, `frontend/package.json`, `packages/{sdk,cli,mcp-server,db}/package.json`, `backend/src/index.ts` (Swagger), `docs/openapi.json`, `docs/PRODUCTION_STATUS.md`.

## [0.2.3] - 2026-07-08

### Added
- **Chunk offsets** (HIAI-1): charStart/charEnd tracking through the embedding pipeline
- **Search chunks** (HIAI-2): `includeChunks` parameter in search to get top-3 chunk snippets per result
- **API keys** (HIAI-3): create, list, revoke, and Bearer-auth user API keys with scopes and expiry
- **Document visibility** (HIAI-4): public/private/shared visibility per document with RLS for public reads
- **Editor plugins** (HIAI-5): read-only Plugin Registry API exposing available editor plugins
- **Reusable rate-limit factory** (HIAI-6): extracted `createRateLimiter` to backend lib for external consumers
- **Share roles** (HIAI-7): viewer/commenter/editor roles on share links with PATCH endpoint
- **Audit log** (HIAI-8): append-only audit trail with admin query endpoints and fire-and-forget integration

### Changed
- ChunkResult extended with charStart/charEnd positional tracking
- Search response extended with optional `chunks` array per document
- Rate-limit middleware now re-exports from reusable lib factory
- Share link schemas accept `role` parameter (default viewer)
- API key auth integrated into auth pipeline (admin key → user API key → Better Auth)

### Security
- API key Bearer auth for user-scoped API access
- Document visibility RLS: public documents readable by all authenticated users
- Audit trail records document/share/API-key lifecycle events

### Migration Notes
- New migrations: 0014 (chunk offsets), 0015 (api_keys table), 0016 (document visibility enum), 0017 (share roles), 0018 (audit_log table)
- Run `bun run db:migrate` after upgrade

## [0.2.2] - 2026-07-07

### Fixed

- **README.md — stale GraphRAG health note**: The note referencing "v0.1.8" and the "AGE shared library auto-loading known gap" was replaced with accurate v0.2.2 wording confirming all GraphRAG audit findings (G1–G9, N1) are resolved. GraphRAG remains optional/off by default and requires explicit `GRAPH_EXTRACT_BASE_URL` for production.
- **docs/PRODUCTION_STATUS.md — test count wording**: Changed "459 base + 3 N1 graph-routes" to the generic "backend/core + frontend" to stay accurate across releases.
- **Version bump**: All workspace packages, CLI, MCP server, Swagger/OpenAPI spec, and docs updated from `0.2.1` to `0.2.2`.

### Changed

- All workspace `package.json` files, `package.public.json`, `packages/sdk/package.json`, `packages/cli/package.json`, `packages/mcp-server/package.json`, `backend/src/index.ts` (Swagger version), `docs/openapi.json`, and `docs/PRODUCTION_STATUS.md` updated to `0.2.2`.

### Documentation

- Stale `v0.1.8`-era GraphRAG language removed from `README.md`. Historical references left intact only where clearly dated/historical (CHANGELOG entries).

## [0.2.1] - 2026-07-07

### Fixed

- **GraphRAG N1 — graph route (`graph.ts`) cypher bind parameter**: `fetchDocumentEntities` in `backend/src/api/routes/graph.ts` used the postgres-js tagged-template form `sql\`...${...}\`` which passes the cypher string as a bind parameter (`$1`). AGE's `cypher()` rejects bind parameters — it requires a literal dollar-quoted string constant. Replaced with `sql.unsafe()` using `$$ ... $$` dollar-quoting, matching the pattern used in `search-expansion.ts` (G7 fix), `extract-entities.ts`, and `admin.ts`.
- **docs/GRAPHRAG_AUDIT.md**: Post-Audit Resolution table updated with N1 fix documentation; remaining risks section cleaned to remove false claims of unresolved CRITICAL/HIGH items.
- **docs/PRODUCTION_STATUS.md**: Updated to v0.2.1 verified status, removing stale v0.1.8 references.
- **docs/openapi.json**: Stale version `0.1.9` corrected to `0.2.1`.
- **packages/sdk/package.json**: Stale version `0.1.9` corrected to `0.2.1`.

### Added

- **Test coverage for N1**: `backend/src/__tests__/graph-routes.test.ts` (3 tests) — verifies `sql.unsafe()` is called with `$$` dollar-quoted cypher, graceful return of `[]` when AGE is unreachable, and special-character docId escaping via JSON.stringify.

### Changed

- All workspace packages, CLI, MCP server, Swagger/OpenAPI spec, and docs version references updated to `0.2.1`.

## [0.2.0] - 2026-07-07

### Breaking Changes
- **MinIO → SeaweedFS migration**: MinIO completely removed as the object storage backend. SeaweedFS (chrislusf/seaweedfs:3.85) is now the only supported storage backend.
- **Config rename**: All `MINIO_*` environment variables renamed to `STORAGE_*` (e.g., `MINIO_ENDPOINT` → `STORAGE_ENDPOINT`, `MINIO_SECRET_KEY` → `STORAGE_SECRET_KEY`). See `.env.example` for the full list.
- **DB schema rename**: `attachments.minio_key` column renamed to `attachments.storage_key` (migration `0013_rename_minio_key_to_storage_key.sql`).
- **npm package change**: `minio` npm dependency replaced with `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`. Exports path `./backend/lib/minio` renamed to `./backend/lib/storage`; `createMinio` renamed to `createObjectStorageClient`.
- **Docker Compose**: MinIO service replaced with SeaweedFS S3 Gateway service. Volume `minio_data` renamed to `seaweedfs_data`.
- **Webhook**: `POST /api/webhooks/minio` replaced with `POST /api/webhooks/storage` as a no-op stub (SeaweedFS does not emit MinIO-compatible bucket notifications).
- **Health check**: MinIO health endpoint removed from `/api/health`; SeaweedFS S3 liveness check added.

## [0.1.9] - 2026-07-03

### Documentation
- Updated all docs to reflect v0.1.8 architecture (B.1/B.4/B.3 refactors)
- Fixed DATABASE_URL default port (5433 → 5437) in config-schema.ts
- Added subpath import examples to README
- Documented factories and module boundaries in ARCHITECTURE.md
- Added missing env vars to DEPLOYMENT.md and README
- Documented /api/admin/metrics endpoint in API.md
- Fixed PRODUCTION_STATUS.md version (v0.1.6 → v0.1.8)

## [0.1.8] - 2026-07-03

### Fixed
- **Pure DI factories** — `createRedis` and `createMinio` (+`ensureBucket`) extracted into `backend/src/lib/redis-factory.ts` and `minio-factory.ts`. These new modules import only `ioredis`/`minio`/`pino`-logger — **no `./config` import**, so no `envSchema.parse` + `process.exit(1)` runs when an external consumer (e.g. docsmint) imports them. The npm subpath exports `./backend/lib/redis` and `./backend/lib/minio` now resolve to these factory files. The original `redis.ts`/`minio.ts` keep their hiai-env-gated singletons for the internal runtime and re-export the factories for backwards compatibility.
- **peerDependencies** — `ioredis`, `minio`, `pino`, `zod` added to `package.public.json` (all optional). Previously a docsmint `import { createRedis } from '@hiai-gg/hiai-docs/backend/lib/redis'` failed to resolve `ioredis` because it was undeclared.
- **bin/files mismatch** — `packages/cli/src` and `packages/mcp-server/src` were removed from `files[]` in v0.1.6 but the `bin` field still pointed at them. Re-added so `npx hiai-docs` / `npx hiai-docs-mcp` work again.
- **`adminTenantContext`** now accepts an optional `ownerId` parameter; the host middleware passes `config.OWNER_ID` explicitly so `packages/db` no longer needs to read `process.env` directly (the env fallback remains for stand-alone use).

## [0.1.7] - 2026-07-03

### Features
- **B.1**: RLS client (withTenant, TenantContext, adminTenantContext, shareGuestTenantContext) moved to packages/db for shared use
- **B.4**: redis and minio refactored to factory functions (createRedis, createMinio) with backwards-compatible singletons
- **B.3**: package.public.json updated with subpath exports for db/client, db/with-tenant, backend/lib/redis, backend/lib/minio, backend/lib/logger

## [0.1.6] - 2026-07-02

### Fixed

- **npm export cleanup** — removed five broken or unnecessary export paths from `package.public.json`:
  - `./auth` was non-functional: `backend/src/lib/auth.ts` imports `@hiai-docs/db`, a `private` workspace package that is not published to npm and therefore cannot be resolved by external consumers. Removed rather than fixed — auth is a server-internal concern and does not belong in the public package surface.
  - `./db` exposed `packages/db/src/index.ts`, which instantiates a `postgres()` connection with a hardcoded `localhost:5433` fallback. This is an internal database client, not a public API. The `./schema` export already covers the Drizzle table definitions that external consumers need.
  - `./backend/*`, `./frontend/*`, `./packages/*` were unscoped wildcard exports that leaked the entire monorepo source tree. No documented use case existed for these paths.
- **`files[]` tightened** — removed `packages/cli/src`, `packages/mcp-server/src`, `backend/src`, `frontend/src` from the published tarball. These directories had no corresponding clean export paths and added ~1 MB of raw TypeScript to the npm package without benefit to consumers.
- **`RELEASE_CHECKLIST.md` version-bump count** corrected from 6 to 8 — `packages/cli/package.json` and `packages/mcp-server/package.json` were omitted from the bump target list.
- **Script file modes** — restored executable permission (`chmod +x`) on `scripts/health-check.sh`, `scripts/migrate.sh`, and `scripts/release.sh`; normalized line endings to LF.

### Added

- **"Option 2: npm SDK" section** in `README.md` — makes it explicit that `bun add @hiai-gg/hiai-docs` installs a programmatic API client, not a deployable server. Includes `DocsClient` quickstart and a table of supported import paths.
- **"For Builders: Extension Points" section** in `README.md` — documents the stable integration surfaces (REST API, MCP server, Drizzle schema import, webhooks) and a "core vs. downstream" boundary table.
- **Extension Guide** in `CONTRIBUTING.md` — code examples for all three integration surfaces and an explicit list of what should not be added to core.
- **`bin` entries** in `package.public.json` — CLI (`hiai-docs`) and MCP server (`hiai-docs-mcp`) are now properly exposed as runnable binaries:
  - `bunx --package @hiai-gg/hiai-docs hiai-docs <command>` — terminal CLI (search, list, read, create, update, delete, folders, history, snapshot, restore, export, config)
  - `bunx --package @hiai-gg/hiai-docs hiai-docs-mcp` / point a source-checkout MCP client at `packages/mcp-server/src/index.ts` — stdio MCP server with 10 tools for AI agents

## [0.1.5] - 2026-07-02

### Fixed

- **npm `files` whitelist** in `package.public.json` now lists explicit per-package source directories (`packages/db/src`, `packages/cli/src`, `packages/mcp-server/src`, `backend/src`, `frontend/src`) instead of the non-recursive glob `packages/*/src`. The glob was silently omitting `packages/db/src`, which broke the `./db` and `./schema` subpaths in the published tarball.
- **Added `./auth` export** pointing to `backend/src/lib/auth.ts` so consumers can import the configured Better Auth instance directly. *(Reverted in 0.1.6 — the export was non-functional due to an unresolvable `@hiai-docs/db` workspace reference.)*

### Changed

- **Version synchronization** — all workspace packages, CLI, MCP server, Swagger/OpenAPI spec, and `docs/openapi.json` now report `0.1.5`.

## [0.1.4] - 2026-07-02

### Changed

- **Frontend UI migration** — migrated the frontend to consume `@hiai-gg/hiai-ui` as the shared UI component library, replacing direct local shadcn-svelte imports where the design system provides equivalent components.
- **Version synchronization** — all workspace packages, CLI, MCP server, Swagger/OpenAPI spec, and `docs/openapi.json` now report `0.1.4`.

## [0.1.3] - 2026-07-02

### Changed

- **Publishable package manifest** (`package.public.json`) now exposes `./db`, `./schema`, `./backend/*`, and `./frontend/*` subpaths, plus wildcard exports for `./packages/*`.
- **SDK dependency cleanup** — removed the `zod` dependency from `packages/sdk` (it was unused; runtime types remain pure TypeScript interfaces).
- **Version synchronization** — all workspace packages, CLI, MCP server, Swagger/OpenAPI spec, and `docs/openapi.json` now report `0.1.3`.

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
