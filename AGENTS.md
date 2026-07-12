# hiai-docs — AGENTS.md

> **Role:** Document module, mountable into hosts (first consumer: `hiai-amigo`); **design-token source** for the ecosystem. Standalone open-source AI-native knowledge base (Markdown-first, auto-embeddings, self-hostable).
> **Status:** ready
> Project documentation lives in README.md, docs/, and AGENTS.md.

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
- **Vector index (optional):** pgvectorscale StreamingDiskANN with SbqCompression, loaded in the unified PostgreSQL image (see `postgres/Dockerfile`)
- **Cache:** Redis 8.6+
- **Storage:** SeaweedFS (S3-compatible)
- **Embeddings:** external embedding API (configurable) + optional self-hosted Ollama; every provider result must be a finite, non-zero 1024-dimensional vector
- **Search:** exact/title, multilingual lexical, fuzzy, vector, adaptive expansion, and GraphRAG channels fused with reciprocal rank fusion (RRF)
- **GraphRAG:** automatic LLM entity extraction + AGE graph expansion in normal search; the operator flag remains a kill switch for degraded deployments
- **Re-embed invariant:** metadata mutations (tag / folder / category rename and delete) MUST trigger re-embed via `backend/src/lib/reembed.ts`.
- **Logging:** Pino
- **Lint:** Biome 2.5+ (`bun run lint`)
- **Tests:** Vitest (`bun test --path-ignore-patterns="*node_modules*"`)
- **Structure:** `backend/src/` (`api/`, `embedding/`, `lib/`) + `frontend/` (SvelteKit) + `packages/db/` (Drizzle)
- **Module boundaries:** `api/` MUST NOT export internal functions · `embedding/` MUST NOT import from `api/` · `lib/` MUST NOT import from `api/` or `embedding/`
- **Env access:** ONLY via `src/lib/config.ts` (Zod); every `CORS_ORIGINS`, `EMBEDDING_*`, `GRAPH_*`, `SEARCH_*`, `HYBRID_*`, `CHUNK_*`, `*_REEMBED_BATCH_SIZE` through `.env`
- **Token import:** `@hiai/ui/styles/tokens.css` (hiai-docs is the token source for the ecosystem)
- **Ports:** API `50700` · frontend dev `50701` · Postgres `5437` · Redis `6384` · SeaweedFS `50702/50703` · Caddy `80/443`
- **No Playwright** — use `agent-browser` for E2E
- **English only** in code, comments, docs, README, AGENTS.md (zero Cyrillic)

## Project Documents

### Core

- `README.md` — project overview, quick start, configuration
- `AGENTS.md` — this file: rules + canonical-document pointer + document index
- `CONTRIBUTING.md` — code style, testing, PR workflow
- `CODE_OF_CONDUCT.md` — community standards
- `SECURITY.md` — vulnerability reporting
- `CHANGELOG.md` — release notes and breaking-change narrative
- `LICENSE` — MIT license

### Project-specific

- [`docs/README.md`](docs/README.md) — documentation index
- [`docs/USAGE.md`](docs/USAGE.md) — product usage, imports, and shortcuts
- [`docs/API.md`](docs/API.md) — REST API and authentication reference
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — services, data isolation, search, and embedding pipeline
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Docker and production operations
- [`docs/EXTENDING.md`](docs/EXTENDING.md) — supported UI extension points
- [`docs/RELEASING.md`](docs/RELEASING.md) — evergreen maintainer release flow
- [`docs/openapi.json`](docs/openapi.json) — machine-readable HTTP contract
- `init.sql` — infrastructure bootstrap

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
| **Cache** | Redis 8.6+ |
| **Auth** | Better Auth |
| **Storage** | SeaweedFS (S3-compatible) |
| **Embeddings** | External embedding API (configurable, optional self-hosted Ollama) |
| **GraphRAG** | Automatic LLM entity extraction + AGE traversal in normal search; graceful degradation when unavailable |
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
psql -h localhost -p 5437 -U aiuser -d hiai_docs -c "SELECT NOW();"
redis-cli -p 6384 ping
curl -fsS http://localhost:50702/
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
  -> stage a pending embedding generation
       v on provider failure
    mark the candidate failed and keep the last active generation queryable
       v on complete valid batch
    atomically activate the new generation, then run GraphRAG extraction
```

The worker does **incremental** re-embed on every save: it hashes each new chunk, compares against the stored `chunkHash`, deletes + reinserts only changed slices (plus their immediate neighbors so overlap regions stay consistent). Unchanged chunks keep their original embeddings.

The worker also stamps each row with the producing model (`embedding_model` column, migration `0006_embedding_model_column.sql`). This makes `POST /api/admin/reindex/model` a precise targeted operation rather than a full reindex.

### Smart Re-embed System

The smart re-embed system ensures vector embeddings stay consistent with metadata changes. Every metadata mutation that changes text prepended to chunk embeddings automatically triggers a re-embed of affected documents. The chunk preamble includes folder name, tag names, and category name — so renaming or deleting any of those leaves stale vectors that reference old names.

The single entry point for metadata-triggered re-embed is `backend/src/lib/reembed.ts`:

| Trigger | Helper used |
|---------|-------------|
| Folder rename / delete | `reembedDocsInFolder(folderId, ownerId)` |
| Category rename / delete | `reembedDocsInCategory(categoryId, ownerId)` |
| Tag rename / delete | `reembedDocsByTag(tagId)` |
| Tag add / remove from document | `enqueueReembed([docId])` |
| Document PATCH (content edit) | `enqueueReembed([docId])` |

#### Incremental Chunk Updates

The embedding worker performs incremental updates using chunk hashing:
- Hashes each new chunk and compares against stored `chunkHash`
- Deletes and reinserts only changed slices (plus immediate neighbors to maintain overlap consistency)
- Unchanged chunks retain their original embeddings
- The `embedding_model` column tracks which model produced each vector, enabling targeted reindex operations

#### Redis Deduplication

All helpers use a Redis `SET NX EX 5` dedup slot so rapid PATCH / auto-save / toggle storms coalesce into a single worker tick. Direct `enqueueEmbedding` calls remain valid for content edits where dedup-by-id is not desirable.

#### Batch Caps

Each helper is bounded by a `*_REEMBED_BATCH_SIZE` env var to prevent spikes in embedding costs:
- `FOLDER_REEMBED_BATCH_SIZE` (default: 100)
- `CATEGORY_REEMBED_BATCH_SIZE` (default: 100)
- `TAG_REEMBED_BATCH_SIZE` (default: 500)

Set any to `0` to disable the cap (not recommended for production with large datasets).

### GraphRAG with Apache AGE

GraphRAG layers a knowledge graph over the retrieval channels to surface related documents beyond exact, lexical, fuzzy, and vector similarity. The reference profile enables extraction and automatic graph expansion for every non-empty search. `GRAPH_SEARCH_ENABLED=false` remains an operator kill switch for deployments without AGE or a graph provider; search degrades to available channels.

#### Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `GRAPH_EXTRACT_ENABLED` | `false` schema fallback; `true` in `.env.example` | Enable LLM entity extraction after ready generations |
| `GRAPH_SEARCH_ENABLED` | `false` schema fallback; `true` in `.env.example` | Enable automatic graph-neighbor expansion in normal search; kill switch for degraded deployments |
| `GRAPH_EXPANSION_BOOST` | `0.3` | Multiplier on graph-discovered neighbor scores (range: 0–2) |
| `GRAPH_EXTRACT_MIN_CONFIDENCE` | `0.5` | Minimum entity confidence threshold (0.0–1.0) |
| `GRAPH_EXTRACT_BASE_URL` | — | OpenAI-compatible chat-completion URL (REQUIRED for extraction) |
| `GRAPH_EXTRACT_API_KEY` | — | API key for extraction LLM |
| `GRAPH_EXTRACT_MODEL` | `EMBEDDING_MODEL` | Extraction model name |

Graph provider credentials are URL-scoped: exact OpenRouter hostnames may use
the shared `OPENROUTER_API_KEY` when no dedicated key is set; local no-auth
endpoints may leave the dedicated key blank; custom providers may set their
own dedicated key. The shared OpenRouter key is never inherited by a
non-OpenRouter endpoint.

**Important:** `GRAPH_EXTRACT_BASE_URL` must be set explicitly in production. Falling back to `EMBEDDING_BASE_URL` is incorrect because extraction uses chat-completion endpoints while embeddings use embedding endpoints.

#### Entity Extraction

When enabled, the embedding worker calls the extraction LLM after each successful embedding. Entities with confidence >= `GRAPH_EXTRACT_MIN_CONFIDENCE` are persisted to Apache AGE as nodes and edges.

#### Graph-Enhanced Search

After the fast retrieval pass and any adaptive query expansion, the search orchestrator walks the AGE graph from authorized seed documents (1–3 hops controlled by `SEARCH_GRAPH_MAX_HOPS`). It also seeds from translated terms, synonyms, concepts, and named entities when direct seeds are unavailable. Graph candidates are fused with the other channels through RRF and capped by `SEARCH_GRAPH_MAX_CONTRIBUTION`; graph neighbors cannot overwhelm strong exact or semantic matches. Graph and provider failures are recorded and never make the entire search fail.

#### Search Configuration

The current ranking contract is reciprocal rank fusion (RRF) across exact/title, FTS, fuzzy, vector, expanded, and graph channels. `SEARCH_RRF_K`, exact-title boost, channel-agreement boost, vector/fuzzy thresholds, graph contribution cap, and graph seed/hop limits are validated through the environment schema. `HYBRID_*` variables remain legacy compatibility inputs and do not control the current orchestrator.

### CORS

Local development requires `CORS_ORIGINS` (frontend and backend run on different ports):

```
CORS_ORIGINS=http://localhost:50701,http://127.0.0.1:50701
```

In production, set to your frontend URL(s).

### Admin Tools & Security Model

All operator tooling lives under `/api/admin` and is gated by a static `HIAI_DOCS_API_KEY` supplied via the `x-api-key` header or `Authorization: Bearer <key>`. See `docs/API.md` for the full surface.

#### Tenant Scoping

The `ADMIN_CROSS_TENANT` env var (default `true`, backward-compatible) controls cross-tenant behavior for admin reindex endpoints:

- **`ADMIN_CROSS_TENANT=true`** (default): Folder and tag reindex endpoints operate in operator scope, bypassing per-user `owner_id` filters. This allows bulk operations across all tenants when the admin API key is trusted.
- **`ADMIN_CROSS_TENANT=false`**: Admin endpoints require explicit `?ownerId=<uuid>` parameter. Useful when the admin API key is shared but data is multi-tenant.

#### Admin Endpoints

- `POST /api/admin/reindex/:docId` — Force re-embed a single document
- `POST /api/admin/reindex/model?dryRun=true` — Targeted re-embed for embedding-model mismatch
- `POST /api/admin/reindex/folder/:folderId?dryRun=true&ownerId=<uuid>` — Bulk re-embed a folder
  - With `ownerId`: owner-scoped operation
  - Without `ownerId` and `ADMIN_CROSS_TENANT=true`: operator-scope via `reembedDocsInFolderAdmin`
  - Without `ownerId` and `ADMIN_CROSS_TENANT=false`: returns 400
- `POST /api/admin/reindex/tag/:tagId?dryRun=true&ownerId=<uuid>` — Bulk re-embed a tag
  - With `ownerId`: owner-scoped via `documentTags JOIN documents`
  - Without `ownerId` and `ADMIN_CROSS_TENANT=true`: operator-scope via `reembedDocsByTag`
  - Without `ownerId` and `ADMIN_CROSS_TENANT=false`: returns 400
- `GET /api/admin/embedding-stats` — Total chunks, documents with embeddings, zero-vector detection
- `GET /api/admin/health/embeddings` — Live embedding provider probe
- `GET /api/admin/graph/stats` — Apache AGE inventory (node and edge counts)

#### Query-Based Access Control

The `?ownerId=<uuid>` query parameter allows:
- Cross-tenant admin operations when `ADMIN_CROSS_TENANT=true`
- Tenant-scoped bulk operations without exposing internal `owner_id` columns
- Fine-grained access control for shared admin credentials

## Configuration

All configuration via `.env`. The Zod schema in `backend/src/lib/config.ts` is the single source of truth — never read `process.env` directly outside that module.

Notable groups:

- **Embedding provider:** `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`, plus optional `*_FALLBACK_*`
- **Legacy hybrid weights:** `HYBRID_TEXT_WEIGHT` (`0.4`), `HYBRID_SEMANTIC_WEIGHT` (`0.6`) remain compatibility inputs; current ranking uses `SEARCH_*` RRF controls
- **Chunking:** `CHUNK_TARGET_TOKENS` (`500`), `CHUNK_OVERLAP_TOKENS` (`50`)
- **Re-embed batch caps:** `FOLDER_REEMBED_BATCH_SIZE` (`100`), `CATEGORY_REEMBED_BATCH_SIZE` (`100`), `TAG_REEMBED_BATCH_SIZE` (`500`)
- **GraphRAG:** `GRAPH_EXTRACT_ENABLED`, `GRAPH_SEARCH_ENABLED`, `GRAPH_EXPANSION_BOOST` (`0.3`), `GRAPH_EXTRACT_*`, `GRAPH_EXTRACT_MIN_CONFIDENCE` (`0.5`)
- **Auth secrets:** `BETTER_AUTH_SECRET`, `CSRF_SECRET`, `WEBHOOK_SECRET`, `STORAGE_SECRET_KEY` — each must be unique and set explicitly in production

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
| postgres | hiai-postgres:18-custom | 5437:5432 | Database (pgvector + pgvectorscale + AGE) |
| redis | redis:8-alpine | 6384:6379 | Cache/queue |
| seaweedfs | chrislusf/seaweedfs:3.85 | 50702:8333, 50703:8888 | File storage |
| api | custom | 50700:50700 | Elysia backend |
| web | custom | 50701:50701 | SvelteKit frontend |
| caddy | caddy:2-alpine | 80:80, 443:443 | Reverse proxy (auto-TLS, build with xcaddy + caddy-ratelimit) |

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

## Secret management (`.env` is provider-input automation only)

- `.env` is **gitignored** (see `.gitignore` line `.env` / `.env.*.local` / `!.env.example`).
- The file at `hiai-docs/.env` is **gitignored** and must never be printed, committed, or uploaded. The quickstart script and an installation agent MAY create it from `.env.example` and write only the provider input explicitly supplied by the user: `OPENROUTER_API_KEY`, or `AI_PROVIDER=ollama` and `OLLAMA_PORT`. They MUST NOT rotate or overwrite existing secrets, change unrelated variables, or copy a key into source code. `quickstart.sh` generates database, auth, storage, and admin secrets when they are placeholders.
- Agents and automation **must NOT create, edit, rotate, or extend** any other `.env` value. This includes but is not limited to:
  - `OPENROUTER_API_KEY` / `EMBEDDING_API_KEY` (real production keys)
  - `BETTER_AUTH_SECRET`, `CSRF_SECRET`, `WEBHOOK_SECRET` (auth signing keys)
  - `HIAI_DOCS_API_KEY` (admin API key)
  - any database or storage credential
- **Where to add new variables**: extend `.env.example` (committed, placeholders only) and, if needed, document the variable in `docs/`. Provider input is the only quickstart exception.
- **If a task appears to require editing a non-provider `.env` value** (e.g. `BETTER_AUTH_SECRET` or `OPENROUTER_FALLBACK_KEY`): STOP and surface the requirement to the user instead of editing it. Provide the exact line to add; let the user paste it.
- **If `.env` already contains a real secret** (e.g. the live OpenRouter key): DO NOT include the secret in any report, checkpoint, memory file, or commit. Reference the variable name only; redact the value.
- The `bun --env-file=.env run` flag in `package.json` scripts reads the file at process start. Changing the run command is fine; mutating the file is not, except for the provider-input quickstart exception above.
- This rule applies to **all** sibling env files: `.env.local`, `.env.production`, `.env.test`, `.env.development`, etc. Only the ignored root `.env` may receive provider input during quickstart; never edit tracked or production env files automatically.
