# hiai-docs — AGENTS.md

> **Role:** Document module, mountable into hosts (first consumer: `hiai-amigo`); **design-token source** for the ecosystem. Standalone open-source AI-native knowledge base (Markdown-first, auto-embeddings, self-hostable).
> **Status:** ready
> **Ecosystem entry point:** [`projects/HIAI_INDEX.md`](../../projects/HIAI_INDEX.md)
> **Canonical rules:** [`docs/hiai-ecosystem/CONVENTIONS.md`](../../docs/hiai-ecosystem/CONVENTIONS.md)

## Cheat-sheet — Conventions

- **Runtime:** Bun 1.3.14+ (no Node, no npm, no yarn)
- **Backend:** Elysia 1.4.28+ (ESM-only, TypeScript strict)
- **Frontend:** SvelteKit 2.60+ + Svelte 5.55+ (`runes: true`)
- **UI:** `@hiai/ui` + shadcn-svelte 1.2.7+ (new-york style) + Tailwind CSS v4
- **Editor:** svelte-tiptap + TipTap v3 (WYSIWYG + raw MD toggle)
- **ORM:** Drizzle ORM 0.45.2+
- **Auth:** Better Auth
- **Validation:** Zod (every route validated)
- **DB:** PostgreSQL 18.4 + pgvector (user-scoped via `owner_id`, `tenant_id` reserved)
- **Graph DB (optional):** Apache AGE on PostgreSQL 17 for GraphRAG (port 5438)
- **Cache:** Redis 8.6+
- **Storage:** MinIO (S3-compatible)
- **Embeddings:** external embedding API (configurable) + optional self-hosted Ollama; hybrid search `HYBRID_TEXT_WEIGHT * full_text + HYBRID_SEMANTIC_WEIGHT * semantic_cosine`
- **GraphRAG:** optional; LLM entity extraction + AGE graph expansion in search. Off by default.
- **Re-embed invariant:** metadata mutations (tag / folder / category rename and delete) MUST trigger re-embed via `backend/src/lib/reembed.ts`.
- **Logging:** Pino
- **Lint:** Biome 2.5+ (`bun run lint`)
- **Tests:** Vitest (`bun test --path-ignore-patterns="*node_modules*"`)
- **Structure:** `backend/src/` (`api/`, `embedding/`, `lib/`) + `frontend/` (SvelteKit) + `packages/db/` (Drizzle)
- **Module boundaries:** `api/` MUST NOT export internal functions · `embedding/` MUST NOT import from `api/` · `lib/` MUST NOT import from `api/` or `embedding/`
- **Env access:** ONLY via `src/lib/config.ts` (Zod); every `CORS_ORIGINS`, `EMBEDDING_*`, `GRAPH_*`, `HYBRID_*`, `CHUNK_*`, `*_REEMBED_BATCH_SIZE` through `.env`
- **Token import:** `@hiai/ui/styles/tokens.css` (hiai-docs is the token source for the ecosystem)
- **Ports:** API `50700` · frontend dev `50701` · Postgres `5433` · Redis `6384` · MinIO `9000/9001` · Caddy `50708/50709` · AGE Postgres `5438`
- **No Playwright** — use `agent-browser` for E2E
- **English only** in code, comments, docs, README, AGENTS.md (zero Cyrillic)

## Project Documents

### Core

- `README.md` — project overview, quick start, configuration
- `AGENTS.md` — this file: rules + canonical-document pointer + document index
- `todo.md` — live task status (active backlog)
- `CONTRIBUTING.md` — code style, testing, PR workflow
- `CODE_OF_CONDUCT.md` — community standards
- `SECURITY.md` — vulnerability reporting
- `CHANGELOG.md` — release notes and breaking-change narrative

### Canonical references (read first)

- [`projects/HIAI_INDEX.md`](../../projects/HIAI_INDEX.md) — single entry point for ecosystem strategy and rules
- [`docs/hiai-ecosystem/CONVENTIONS.md`](../../docs/hiai-ecosystem/CONVENTIONS.md) — **rules and topology** (§1 stack, §2 structure, §3 ports, §4 design tokens, §5 auth/RBAC, §6 plugin/embed contract)
- [`docs/hiai-ecosystem/ARCHITECTURE.md`](../../docs/hiai-ecosystem/ARCHITECTURE.md) — architecture (host/module roles, integration map)
- [`docs/hiai-ecosystem/PORTS.md`](../../docs/hiai-ecosystem/PORTS.md) — port registry (docs = 50700/50701)
- [`docs/hiai-ecosystem/DESIGN_SYSTEM.md`](../../docs/hiai-ecosystem/DESIGN_SYSTEM.md) — design tokens and `@hiai/ui` contract (hiai-docs is the source of tokens)
- [`docs/hiai-ecosystem/PLUGIN_CONTRACT.md`](../../docs/hiai-ecosystem/PLUGIN_CONTRACT.md) — plugin/embed contract (how hosts connect docs)

### Project-specific

- [`docs/design-spec.md`](docs/design-spec.md) — design spec (UI/UX and tokens)
- [`docs/API.md`](docs/API.md) — REST API reference
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — internal architecture (data isolation, embedding pipeline)
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — deployment (Docker, VPS)
- [`docs/PRODUCTION_STATUS.md`](docs/PRODUCTION_STATUS.md) — production status
- [`docs/categories.md`](docs/categories.md), [`docs/keyboard-shortcuts.md`](docs/keyboard-shortcuts.md), [`docs/upload.md`](docs/upload.md), [`docs/openapi.json`](docs/openapi.json) — reference
- `RELEASE_CHECKLIST.md` — release checklist
- `init.sql` — initial schema

## Runtime Contract

| Property | Value |
|----------|-------|
| **Runtime** | Bun 1.3.14+ |
| **Backend** | Elysia 1.4.28+ (ESM-only) |
| **Frontend** | SvelteKit 2.60+ + Svelte 5.55+ |
| **UI** | shadcn-svelte 1.2.7+ (new-york style) + Tailwind CSS v4 |
| **Editor** | svelte-tiptap + TipTap v3 |
| **ORM** | Drizzle ORM 0.45.2+ |
| **Database** | PostgreSQL 18.4 + pgvector |
| **Graph database (optional)** | Apache AGE on PostgreSQL 17 (port 5438) |
| **Cache** | Redis 8.6+ |
| **Auth** | Better Auth |
| **Storage** | MinIO (S3-compatible) |
| **Embeddings** | External embedding API (configurable, optional self-hosted Ollama) |
| **GraphRAG** | Optional; LLM entity extraction + AGE traversal in search |
| **Logging** | Pino |
| **Validation** | Zod |
| **API port** | 50700 |
| **Frontend port** | 50701 |
| **Module system** | ESM-only, TypeScript strict |

## Canonical Commands

| Task | Command | Working dir |
|------|---------|-------------|
| **Install** | `bun install` | root |
| **Dev (all)** | `bun run dev` | root |
| **Dev (api)** | `bun run dev` | `backend/` |
| **Dev (web)** | `bun run dev` | `frontend/` |
| **Lint** | `bun run lint` | root |
| **Typecheck** | `bun run typecheck` | root |
| **Test** | `bun test` | `backend/` or `frontend/` |
| **DB push** | `bun run db:push` | `packages/db/` |
| **DB generate** | `bun run db:generate` | `packages/db/` |
| **DB migrate** | `bun run db:migrate` | `packages/db/` |
| **Docker up** | `docker compose up -d` | root |
| **Docker down** | `docker compose down` | root |
| **Backup** | `scripts/prework_backup.sh hiai-docs` | root |

## Health Checks

```bash
curl -fsS http://localhost:50700/api/health
psql -h localhost -p 5433 -U aiuser -d hiai_docs -c "SELECT NOW();"
redis-cli -p 6384 ping
curl -fsS http://localhost:9000/minio/health/live
```

## Architecture

### Data isolation

- **Current:** user-scoped (`owner_id` on every table)
- **Future:** `tenant_id` nullable column reserved for multi-tenancy
- Every query MUST include `WHERE owner_id = $1`
- No cross-user data access except via share_links

### Module boundaries

```
backend/src/
├── api/              # HTTP layer (routes, middleware)
│   ├── routes/       # Route handlers
│   └── middleware/   # Auth, rate-limit, logging
├── embedding/        # Embedding pipeline (isolated from API)
├── lib/              # Shared utilities (db, config, logger, reembed)
└── index.ts          # Entry point
```

- `api/` MUST NOT export internal functions — only route registrations
- `embedding/` MUST NOT import from `api/` — use event bus or queue
- `lib/` MUST NOT import from `api/` or `embedding/`

### Embedding pipeline

```
document.save()
  -> chunk(CHUNK_TARGET_TOKENS, CHUNK_OVERLAP_TOKENS)
  -> embed(provider)
  -> store(document_embeddings { embeddingModel: config.EMBEDDING_MODEL ?? "" })
       v on failure
    fallback(provider) -> dummy zero vector
```

The worker does **incremental** re-embed on every save: it hashes each new chunk, compares against the stored `chunkHash`, deletes + reinserts only changed slices (plus their immediate neighbors so overlap regions stay consistent). Unchanged chunks keep their original embeddings.

The worker also stamps each row with the producing model (`embedding_model` column, migration `0006_embedding_model_column.sql`). This makes `POST /api/admin/reindex/model` a precise targeted operation rather than a full reindex.

### Re-embed invariant (system-wide)

**Every metadata mutation that changes text prepended to chunk embeddings MUST trigger a re-embed of every affected document.** The chunk preamble includes folder name, tag names, and category name — so renaming or deleting any of those leaves stale vectors that still reference the old name in semantic search.

The single entry point for metadata-triggered re-embed is `backend/src/lib/reembed.ts`:

| Trigger | Helper used |
|---------|-------------|
| Folder rename / delete | `reembedDocsInFolder(folderId, ownerId)` |
| Category rename / delete | `reembedDocsInCategory(categoryId, ownerId)` |
| Tag rename / delete | `reembedDocsByTag(tagId)` |
| Tag add / remove from document | `enqueueReembed([docId])` |
| Document PATCH (content edit) | `enqueueReembed([docId])` |

All helpers use a Redis `SET NX EX 5` dedup slot so a rapid PATCH / auto-save / toggle storm coalesces into a single worker tick. Direct `enqueueEmbedding` calls remain valid for content edits where dedup-by-id is not desirable, and for admin reindex paths.

Each helper is bounded by a `*_REEMBED_BATCH_SIZE` env var (defaults 100 / 100 / 500) so a rename of a mega-folder does not spike embedding costs in a single tick. Set to `0` to disable the cap.

### GraphRAG (optional)

GraphRAG is opt-in via feature flags. Off by default.

- **`GRAPH_EXTRACT_ENABLED=true`** — after every embedding, the worker calls an LLM to extract entities (with confidence >= `GRAPH_EXTRACT_MIN_CONFIDENCE`, default `0.5`) and persists them as nodes and edges in Apache AGE.
- **`GRAPH_SEARCH_ENABLED=true`** — `GET /api/search?graph=true&graphHops=N&graphBoost=N` walks the AGE graph from each merged seed doc and merges discovered neighbors into the result list.
- **`GRAPH_EXPANSION_BOOST`** (default `0.3`) — multiplier on graph-discovered neighbor scores; also applied as a multiplicative boost to already-present docs that the graph also surfaces.

Both the extraction LLM and the embedding provider must be OpenAI-compatible (`POST {url}/chat/completions` and `POST {url}/embeddings` respectively). `GRAPH_EXTRACT_BASE_URL` MUST be set explicitly in production — falling back to `EMBEDDING_BASE_URL` is almost always wrong because the chat endpoint differs from the embedding endpoint.

### Search

Hybrid search: `HYBRID_TEXT_WEIGHT * full_text + HYBRID_SEMANTIC_WEIGHT * semantic_cosine` (defaults `0.4 / 0.6`). When graph expansion is enabled and requested, the merged list is broadened with AGE-walked neighbors; existing docs receive a multiplicative `GRAPH_EXPANSION_BOOST` boost if they also show up as a graph neighbor.

### CORS

Local development requires `CORS_ORIGINS` (frontend and backend run on different ports):

```
CORS_ORIGINS=http://localhost:50701,http://127.0.0.1:50701
```

In production, set to your frontend URL(s).

### Admin endpoints

All operator tooling lives under `/api/admin` and is gated by a static `HIAI_DOCS_API_KEY` supplied via the `x-api-key` header. See `docs/API.md` for the full surface. Notable endpoints:

- `POST /api/admin/reindex/:docId` — force re-embed one document
- `POST /api/admin/reindex/model?dryRun=true` — targeted re-embed for embedding-model mismatch
- `POST /api/admin/reindex/folder/:folderId?dryRun=true` — bulk re-embed a folder (uses operator-scope `reembedDocsInFolderAdmin(folderId)` from `backend/src/lib/reembed.ts`, which bypasses the `owner_id` filter — the user-scoped helper would match zero rows because admin callers have no `owner_id`)
- `POST /api/admin/reindex/tag/:tagId?dryRun=true` — bulk re-embed a tag
- `GET /api/admin/embedding-stats` — chunk counts and zero-vector detection
- `GET /api/admin/health/embeddings` — live provider probe
- `GET /api/admin/graph/stats` — AGE inventory

## Configuration

All configuration via `.env`. The Zod schema in `backend/src/lib/config.ts` is the single source of truth — never read `process.env` directly outside that module.

Notable groups:

- **Embedding provider:** `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`, plus optional `*_FALLBACK_*`
- **Hybrid search weights:** `HYBRID_TEXT_WEIGHT` (`0.4`), `HYBRID_SEMANTIC_WEIGHT` (`0.6`)
- **Chunking:** `CHUNK_TARGET_TOKENS` (`500`), `CHUNK_OVERLAP_TOKENS` (`50`)
- **Re-embed batch caps:** `FOLDER_REEMBED_BATCH_SIZE` (`100`), `CATEGORY_REEMBED_BATCH_SIZE` (`100`), `TAG_REEMBED_BATCH_SIZE` (`500`)
- **GraphRAG:** `GRAPH_EXTRACT_ENABLED`, `GRAPH_SEARCH_ENABLED`, `GRAPH_EXPANSION_BOOST` (`0.3`), `GRAPH_EXTRACT_*`, `GRAPH_EXTRACT_MIN_CONFIDENCE` (`0.5`), `AGE_DATABASE_URL`
- **Auth secrets:** `BETTER_AUTH_SECRET`, `CSRF_SECRET`, `WEBHOOK_SECRET`, `MINIO_SECRET_KEY` — each must be unique and set explicitly in production

Full list with defaults: see `.env.example`.

## Coding Guidelines

### Hard rules

- **Bun-native:** no npm/yarn, no Node-only packages, no CommonJS
- **ESM-only:** all imports use ESM syntax
- **TypeScript strict:** no `any`, proper Zod validation on all inputs
- **English only:** code, comments, docs, README, AGENTS.md — zero Cyrillic
- **No Playwright:** use `agent-browser` for E2E testing
- **No root-file sprawl:** every file belongs in a canonical directory
- **Environment-driven:** all config in `.env`, zero hardcoded paths/keys
- **No autonomous git pushes:** push requires explicit user authorization
- **Re-embed invariant:** metadata mutations MUST go through `backend/src/lib/reembed.ts`

### TypeScript config

```jsonc
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true
  }
}
```

### Dev quirks and known workarounds

These are non-obvious project decisions pinned in `package.json` / Dockerfiles. Do not "clean up" without first understanding the constraint.

- **`@sinclair/typebox` (pinned in root devDependencies)** — forces a single Typebox version across the workspace to resolve a peer-dep conflict with Elysia 1.4.28. Required for `bun install` to succeed; do not remove.
- **`bun test --path-ignore-patterns="*node_modules*"`** — Bun 1.3's smart test discovery walks into hoisted `node_modules` and tries to run upstream library tests, which fail on missing fixtures. The path-ignore flag scopes test discovery to our own `src/` and `tests/` directories. Keep this flag on every `test` script.
- **Paraglide v2 SvelteKit integration** — i18n is driven by `@inlang/paraglide-js@2.x` directly. The deprecated `@inlang/paraglide-sveltekit` adapter is NOT used. Setup:
  - `frontend/vite.config.ts` registers `paraglideVitePlugin({ project, outdir, strategy })`.
  - `frontend/src/hooks.ts` exports a `reroute` hook calling `deLocalizeUrl(request.url).pathname`.
  - `frontend/src/hooks.server.ts` exports `handle` wrapping `paraglideMiddleware()` from the generated `$lib/paraglide/server.js`.
  - Components use `import * as m from "$lib/paraglide/messages.js"` and `import { getLocale } from "$lib/paraglide/runtime"`.
  - The `frontend/Dockerfile` does NOT need any `sed` patch — `@inlang/sdk@2.x` no longer triggers Bun's `NameTooLong` error.

### Svelte rules

- Svelte 5 runes enforced globally (`runes: true`)
- `$props()` for component props, `{@render children?.()}` for slots
- `$derived.by()` for multi-line derived values
- `$effect()` returns void — cleanup inside body
- `import type` only for type-only imports (not for `bind:this` targets)
- `import { page } from '$app/state'` (not `$app/stores`)
- `./$types` generated at build time — ignore IDE errors

### API rules

- Every route validated with Zod schemas
- Rate limiting on all public endpoints (Redis-based)
- Pino logger with structured logging
- Better Auth session check on all protected routes
- `set.status` for HTTP status codes (Elysia pattern)
- Re-embed through `backend/src/lib/reembed.ts`, never direct `enqueueEmbedding` for metadata mutations

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on code style, testing, and PR workflow.

## Docker Services

| Container | Image | Port | Purpose |
|-----------|-------|------|---------|
| postgres | pgvector/pgvector:pg18 | 5433:5432 | Database (pgvector + pg_trgm) |
| age-postgres | apache/age:pg17 | 5438:5432 | Graph database (Apache AGE for GraphRAG) |
| redis | redis:8-alpine | 6384:6379 | Cache/queue |
| minio | minio/minio:latest | 9000:9000, 9001:9021 | File storage |
| api | custom | 50700:50700 | Elysia backend |
| web | custom | 50701:50701 | SvelteKit frontend |
| caddy | caddy:2-alpine | 50708:80, 50709:443 | Reverse proxy (profile-only, not started by default) |

## Multi-Agent Development

### Wave structure

Phases are designed for parallel agent execution:

- **Foundation wave:** schema + Docker + config (sequential, shared state)
- **Backend wave:** API routes (parallel by domain: docs, folders, search, share, tags)
- **Frontend wave:** pages + components (parallel by page)
- **Integration wave:** API + frontend wiring (sequential)
- **Polish wave:** tests + docs + deploy (parallel)

### File ownership matrix

Each agent claims exclusive file ownership to prevent conflicts:

- Backend routes: one agent per route domain
- Frontend pages: one agent per page
- Shared utilities: foundation agent only
- Schema: foundation agent only
- Migration SQL: foundation agent only

### Post-agent cleanup

After parallel agent waves:

1. Run `bun run typecheck` — fix all TS errors
2. Run `bun test` — fix failing tests
3. Run `bun run lint` — fix lint issues
4. Verify no duplicate imports/exports
5. Verify no orphaned files
6. Verify the re-embed invariant: every metadata mutation routes through `backend/src/lib/reembed.ts`

## CLOSURE_PROTOCOL

End every response with a structured `<CLOSURE>` block:

```xml
<CLOSURE>
{
  "reasoning": "Concise summary of what was achieved.",
  "evidence": ["File paths", "Test results", "LSP diagnostics"],
  "readiness": "done" | "accept" | "reject"
}
</CLOSURE>
```

> **Note:** This file (`AGENTS.md`) and `todo.md` are added to `.gitignore` and not committed. They contain operational instructions for agents and may change without review.