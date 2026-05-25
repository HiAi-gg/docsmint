# hiai-docs

> Standalone, open-source, AI-native knowledge base. Markdown-first, auto-embeddings, self-hostable.

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
| **Embeddings** | Ollama (configurable, API fallback) |
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

# Ollama
curl -fsS http://localhost:11434/api/tags

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
EMBEDDING_PROVIDER=ollama|openrouter|voyage
EMBEDDING_FALLBACK_PROVIDER=openrouter
```

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

## Agent Routing

| Intent | Skill/Agent |
|--------|------------|
| Feature work | spec-driven-development → planning → implementation |
| Bug fixing | systematic-debugging |
| Code review | code-review-and-quality |
| Refactoring | code-simplification |
| Frontend UI | frontend-ui-engineering |
| Testing | test-driven-development |
| Deployment | shipping-and-launch |

## Docker Services

| Container | Image | Port | Purpose |
|-----------|-------|------|---------|
| postgres | pgvector/pgvector:pg18 | 5433:5432 | Database |
| redis | redis:8-alpine | 6380:6379 | Cache/queue |
| ollama | ollama/ollama | 11434:11434 | Embeddings |
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
