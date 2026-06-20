# hiai-docs

> Standalone, open-source, AI-native knowledge base. Markdown-first, auto-embeddings, self-hostable.

## Project Documents

- `README.md` — project overview, quick start, configuration
- `AGENTS.md` — this file: architecture, coding guidelines, agent instructions
- `CONTRIBUTING.md` — code style, testing, PR workflow
- `CODE_OF_CONDUCT.md` — community standards
- `SECURITY.md` — vulnerability reporting

## Identity & Purpose

**hiai-docs** is a self-hosted knowledge base with built-in vector embeddings for RAG-ready semantic search. Alternative to Outline/Docmost with focus on simplicity, AI integration, and data ownership.

**Open-source (MIT).** All paths, keys, dependencies via `.env`. Zero hardcoded secrets.

## Runtime Contract

| Property | Value |
|----------|-------|
| **Runtime** | Bun 1.3.14+ |
| **Backend** | Elysia 1.4.28+ (ESM-only) |
| **Frontend** | SvelteKit 2.60+ + Svelte 5.55+ |
| **UI** | shadcn-svelte 1.2.7+ (new-york style) + Tailwind CSS v4 |
| **Editor** | svelte-tiptap + TipTap v3 (WYSIWYG + raw MD toggle) |
| **ORM** | Drizzle ORM 0.45.2+ |
| **Database** | PostgreSQL 18.4 + pgvector |
| **Cache** | Redis 8.6+ |
| **Auth** | Better Auth |
| **Storage** | MinIO (S3-compatible) |
| **Embeddings** | External embedding API (configurable, optional self-hosted Ollama) |
| **Logging** | Pino |
| **Validation** | Zod |
| **API Port** | 50700 |
| **Frontend Port** | 50701 |
| **Module System** | ESM-only, TypeScript strict |

## Canonical Commands

| Task | Command | Working Dir |
|------|---------|-------------|
| **Install** | `bun install` | Root |
| **Dev (all)** | `bun run dev:all` | Root |
| **Dev (api)** | `bun run dev` | `backend/` |
| **Dev (web)** | `bun run dev` | `frontend/` |
| **Lint** | `bun run lint` | Root |
| **Typecheck** | `bun run typecheck` | Root |
| **Test** | `bun test` | `backend/` or `frontend/` |
| **DB Push** | `bun run db:push` | `packages/db/` |
| **DB Generate** | `bun run db:generate` | `packages/db/` |
| **DB Migrate** | `bun run db:migrate` | `packages/db/` |
| **Docker Up** | `docker compose up -d` | Root |
| **Docker Down** | `docker compose down` | Root |
| **Backup** | `scripts/prework_backup.sh hiai-docs` | Root |

## Health Checks

```bash
# API health
curl -fsS http://localhost:50700/api/health

# Database
psql -h localhost -p 5433 -U aiuser -d hiai_docs -c "SELECT NOW();"

# Redis
redis-cli -p 6380 ping



# MinIO
curl -fsS http://localhost:9000/minio/health/live
```

## Architecture

### Data Isolation

- **Current:** User-scoped (`owner_id` on every table)
- **Future:** `tenant_id` nullable column reserved for multi-tenancy
- Every query MUST include `WHERE owner_id = $1`
- No cross-user data access except via share_links

### Module Boundaries

```
backend/src/
├── api/              # HTTP layer (routes, middleware)
│   ├── routes/       # Route handlers
│   └── middleware/    # Auth, rate-limit, logging
├── embedding/        # Embedding pipeline (isolated from API)
├── lib/              # Shared utilities (db, config, logger)
└── index.ts          # Entry point
```

- `api/` MUST NOT export internal functions — only route registrations
- `embedding/` MUST NOT import from `api/` — use event bus or queue
- `lib/` MUST NOT import from `api/` or `embedding/`

### Embedding Pipeline

```
document.save() → chunk(500 tokens, 50 overlap) → embed(provider) → store(pgvector)
                                                    ↓ on failure
                                              fallback(provider) → dummy vector
```

Configured via `.env`:
```
# Embedding configuration (choose ONE provider)
EMBEDDING_BASE_URL=https://api.example.com/v1  # Base URL for embedding API
EMBEDDING_API_KEY=your-api-key-here            # API key for embedding service
EMBEDDING_MODEL=text-embedding-3-small         # Model to use for embeddings

# Optional fallback (if primary fails)
EMBEDDING_FALLBACK_BASE_URL=https://api.example.com/v1
EMBEDDING_FALLBACK_API_KEY=your-api-key-here
EMBEDDING_FALLBACK_MODEL=text-embedding-3-small
```

For self-hosted Ollama (optional):
```
EMBEDDING_BASE_URL=http://localhost:11434/api/embeddings
```

### CORS
Local development requires CORS_ORIGINS to be set (frontend and backend run on different ports):
```
CORS_ORIGINS=http://localhost:50701,http://127.0.0.1:50701
```
In production, set to your frontend URL(s).

### Search

Hybrid search: `0.4 * full_text + 0.6 * semantic_cosine` (configurable weights)

## Coding Guidelines

### Hard Rules

- **Bun-native:** No npm/yarn, no Node-only packages, no CommonJS
- **ESM-only:** All imports use ESM syntax
- **TypeScript strict:** No `any`, proper Zod validation on all inputs
- **English only:** Code, comments, docs, README, AGENTS.md — zero Russian
- **No Playwright:** Use agent-browser for E2E testing
- **No root file sprawl:** Every file belongs in a canonical directory
- **Environment-driven:** All config in `.env`, zero hardcoded paths/keys
- **No autonomous git pushes:** Push requires explicit user authorization

### TypeScript Config

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

### Dev Quirks & Known Workarounds

These are non-obvious project decisions pinned in `package.json` / Dockerfiles. Do not "clean up" without first understanding the constraint.

- **`@sinclair/typebox@^0.34.0` (root devDependency)** — Forces a single Typebox version across the workspace to resolve a peer-dep conflict with Elysia 1.4.28. Required for `bun install` to succeed; do not remove.
- **`bun test --path-ignore-patterns='*node_modules*'`** — Bun 1.3's smart test discovery walks into hoisted `node_modules` and tries to run upstream library tests, which fail on missing fixtures. The path-ignore flag scopes test discovery to our own `src/` and `tests/` directories. Keep this flag on every `test` script.
- **Paraglide v2 SvelteKit integration** — i18n is driven by `@inlang/paraglide-js@2.x` directly. The deprecated `@inlang/paraglide-sveltekit` adapter is NOT used. Setup:
  - `frontend/vite.config.ts` registers `paraglideVitePlugin({ project, outdir, strategy })`.
  - `frontend/src/hooks.ts` exports a `reroute` hook calling `deLocalizeUrl(request.url).pathname`.
  - `frontend/src/hooks.server.ts` exports `handle` wrapping `paraglideMiddleware()` from the generated `$lib/paraglide/server.js`.
  - Components use `import * as m from "$lib/paraglide/messages.js"` and `import { getLocale } from "$lib/paraglide/runtime"`.
  - The `frontend/Dockerfile` does NOT need any `sed` patch — `@inlang/sdk@2.x` no longer triggers Bun's `NameTooLong` error.

### Svelte Rules

- Svelte 5 runes enforced globally (`runes: true`)
- `$props()` for component props, `{@render children?.()}` for slots
- `$derived.by()` for multi-line derived values
- `$effect()` returns void — cleanup inside body
- `import type` only for type-only imports (not for bind:this targets)
- `import { page } from '$app/state'` (not `$app/stores`)
- `./$types` generated at build time — ignore IDE errors

### API Rules

- Every route validated with Zod schemas
- Rate limiting on all public endpoints (Redis-based)
- Pino logger with structured logging
- Better Auth session check on all protected routes
- `set.status` for HTTP status codes (Elysia pattern)

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on code style, testing, and PR workflow.

## Docker Services

| Container | Image | Port | Purpose |
|-----------|-------|------|---------|
| postgres | pgvector/pgvector:pg18 | 5433:5432 | Database |
| redis | redis:8-alpine | 6380:6379 | Cache/queue |
| minio | minio/minio | 9000:9000, 9001:9001 | File storage |
| api | custom | 50700:50700 | Elysia backend |
| web | custom | 50701:50701 | SvelteKit frontend |
| caddy | caddy:2-alpine | 80:80, 443:443 | Reverse proxy |

## Multi-Agent Development

### Wave Structure

Phases are designed for parallel agent execution:
- **Foundation wave:** Schema + Docker + config (sequential, shared state)
- **Backend wave:** API routes (parallel by domain: docs, folders, search, share, tags)
- **Frontend wave:** Pages + components (parallel by page)
- **Integration wave:** API + frontend wiring (sequential)
- **Polish wave:** Tests + docs + deploy (parallel)

### File Ownership Matrix

Each agent claims exclusive file ownership to prevent conflicts:
- Backend routes: one agent per route domain
- Frontend pages: one agent per page
- Shared utilities: foundation agent only
- Schema: foundation agent only

### Post-Agent Cleanup

After parallel agent waves:
1. Run `bun run typecheck` — fix all TS errors
2. Run `bun test` — fix failing tests
3. Run `bun run lint` — fix lint issues
4. Verify no duplicate imports/exports
5. Verify no orphaned files

## CLOSURE_PROTOCOL

### Mandatory Task Finalization

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
