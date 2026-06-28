# hiai-docs — AGENTS.md

> **Роль:** модуль документов, подключаемый в хосты (первый потребитель — `hiai-amigo`); **источник дизайн-токенов** для экосистемы. Standalone open-source AI-native knowledge base (Markdown-first, auto-embeddings, self-hostable).
> **Статус:** готов
> **Точка входа экосистемы:** [`projects/HIAI_INDEX.md`](../../projects/HIAI_INDEX.md)
> **Канонические правила:** [`docs/hiai-ecosystem/CONVENTIONS.md`](../../docs/hiai-ecosystem/CONVENTIONS.md)

## Cheat-sheet конвенций

- **Runtime:** Bun 1.3.14+ (no Node, no npm, no yarn)
- **Backend:** Elysia 1.4.28+ (ESM-only, TypeScript strict)
- **Frontend:** SvelteKit 2.60+ + Svelte 5.55+ (`runes: true`)
- **UI:** `@hiai/ui` + shadcn-svelte 1.2.7+ (new-york style) + Tailwind CSS v4
- **Editor:** svelte-tiptap + TipTap v3 (WYSIWYG + raw MD toggle)
- **ORM:** Drizzle ORM 0.45.2+
- **Auth:** Better Auth
- **Validation:** Zod (every route validated)
- **DB:** PostgreSQL 18.4 + pgvector (user-scoped via `owner_id`, `tenant_id` reserved)
- **Cache:** Redis 8.6+
- **Storage:** MinIO (S3-compatible)
- **Embeddings:** external embedding API (configurable) + optional self-hosted Ollama; `0.4 * full_text + 0.6 * semantic_cosine` (hybrid search)
- **Logging:** Pino
- **Lint:** Biome 2.5+ (`bun run lint`)
- **Tests:** Vitest (`bun test --path-ignore-patterns='*node_modules*'`)
- **Структура:** `backend/src/` (api/, embedding/, lib/) + `frontend/` (SvelteKit) + `packages/db/` (Drizzle)
- **Module boundaries:** `api/` ≠ экспорт внутренних функций · `embedding/` ≠ импорт из `api/` · `lib/` ≠ импорт из `api/` или `embedding/`
- **env только через** `src/lib/config.ts` (Zod); все `CORS_ORIGINS`, `EMBEDDING_*` через `.env`
- **Импорт токенов:** `@hiai/ui/styles/tokens.css` (hiai-docs — источник токенов для экосистемы)
- **Порты:** API `50700` · frontend dev `50701` · Postgres `5433` · Redis `6384` · MinIO `9000/9001` · Caddy `50708/50709`
- **No Playwright** — использовать `agent-browser` для E2E
- **English-only в коде/комментариях/README/AGENTS.md** (zero Russian)

## Индекс проектных документов

### Core
- `README.md` — обзор проекта, quick start, конфигурация
- `AGENTS.md` — этот файл: правила + указатель на канонические документы + индекс документов
- `todo.md` — живой статус задач (активный бэклог)
- `CONTRIBUTING.md` — code style, testing, PR workflow
- `CODE_OF_CONDUCT.md` — community standards
- `SECURITY.md` — vulnerability reporting

### Канонические ссылки (читать первыми)
- [`projects/HIAI_INDEX.md`](../../projects/HIAI_INDEX.md) — единая точка входа в стратегию и правила экосистемы
- [`docs/hiai-ecosystem/CONVENTIONS.md`](../../docs/hiai-ecosystem/CONVENTIONS.md) — **правила и топология** (§1 стек, §2 структура, §3 порты, §4 дизайн-токены, §5 auth/RBAC, §6 plugin/embed-контракт)
- [`docs/hiai-ecosystem/ARCHITECTURE.md`](../../docs/hiai-ecosystem/ARCHITECTURE.md) — архитектура (роли host/module, карта подключений)
- [`docs/hiai-ecosystem/PORTS.md`](../../docs/hiai-ecosystem/PORTS.md) — реестр портов (docs = 50700/50701)
- [`docs/hiai-ecosystem/DESIGN_SYSTEM.md`](../../docs/hiai-ecosystem/DESIGN_SYSTEM.md) — дизайн-токены и `@hiai/ui` контракт (hiai-docs = источник токенов)
- [`docs/hiai-ecosystem/PLUGIN_CONTRACT.md`](../../docs/hiai-ecosystem/PLUGIN_CONTRACT.md) — контракт plugin/embed-контракта (как host-ы подключают docs)

### Project-specific
- [`docs/design-spec.md`](docs/design-spec.md) — спецификация дизайна (UI/UX и токены)
- [`docs/API.md`](docs/API.md) — REST API reference
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — внутренняя архитектура (data isolation, embedding pipeline)
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — деплой (Docker, VPS)
- [`docs/PRODUCTION_STATUS.md`](docs/PRODUCTION_STATUS.md) — статус продакшена
- [`docs/categories.md`](docs/categories.md), [`docs/keyboard-shortcuts.md`](docs/keyboard-shortcuts.md), [`docs/upload.md`](docs/upload.md), [`docs/openapi.json`](docs/openapi.json) — справочные
- `RELEASE_CHECKLIST.md` — чеклист релиза
- `init.sql` — начальная схема

### Quirks & workarounds (закреплено в `package.json`/Dockerfile)
- `@sinclair/typebox` pinned в root devDependencies — резолв peer-dep конфликта с Elysia 1.4.28; **не удалять**.
- `bun test --path-ignore-patterns='*node_modules*'` — обязательный флаг на каждом `test` script (Bun 1.3 walks hoisted node_modules).
- Paraglide v2: `frontend/vite.config.ts` → `paraglideVitePlugin`; `frontend/src/hooks.ts` → `reroute` с `deLocalizeUrl`; `frontend/src/hooks.server.ts` → `paraglideMiddleware`. Deprecated `@inlang/paraglide-sveltekit` НЕ используется.

> **Примечание:** Этот файл (`AGENTS.md`) и `todo.md` добавлены в `.gitignore` и не коммитятся.
> Они содержат оперативные инструкции для агентов и могут меняться без review.

---

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
| **Dev (all)** | `bun run dev` | Root |
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
redis-cli -p 6384 ping



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

- **`@sinclair/typebox` (pinned in root devDependencies)** — Forces a single Typebox version across the workspace to resolve a peer-dep conflict with Elysia 1.4.28. Required for `bun install` to succeed; do not remove.
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
| redis | redis:8-alpine | 6384:6379 | Cache/queue |
| minio | minio/minio:latest | 9000:9000, 9001:9021 | File storage |
| api | custom | 50700:50700 | Elysia backend |
| web | custom | 50701:50701 | SvelteKit frontend |
| caddy | caddy:2-alpine | 50708:80, 50709:443 | Reverse proxy (profile-only, not started by default) |

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
