# Architecture

## Monorepo Structure

```
hiai-docs/
├── backend/              # Elysia REST API (Bun runtime)
│   └── src/
│       ├── api/routes/   # Route handlers (documents, folders, search, share, tags, auth)
│       ├── api/middleware/# Auth middleware
│       ├── embedding/    # Embedding pipeline (chunker, providers, queue)
│       └── lib/          # Shared utilities (db, redis, config, logger, minio)
├── frontend/             # SvelteKit 2 + Svelte 5 + Tailwind CSS v4
│   └── src/
│       ├── routes/       # Pages (+page.svelte per route)
│       └── lib/
│           ├── components/ # UI components (sidebar, editor, cards)
│           ├── components/ui/ # shadcn-svelte primitives
│           └── api/      # API client functions
├── packages/db/          # Drizzle ORM schema + migrations (shared)
│   └── src/
│       ├── schema.ts     # Table definitions + relations
│       └── client.ts     # Database client
└── docker-compose.yml    # Full stack deployment
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Bun 1.3.14+ |
| Backend | Elysia 1.4.28+ |
| ORM | Drizzle 0.45.2+ |
| Database | PostgreSQL 18 + pgvector |
| Cache | Redis 8.6+ |
| Auth | Better Auth |
| Frontend | SvelteKit 2.60+ / Svelte 5.55+ |
| UI | shadcn-svelte (new-york) + Tailwind v4 |
| Editor | TipTap + svelte-tiptap |
| Embeddings | Ollama (configurable) |
| Storage | MinIO (S3-compatible) |

## Data Flow

```
User → SvelteKit Frontend → REST API (Elysia) → PostgreSQL
                                              → Redis (queue/cache)
                                              → MinIO (attachments)
                                              → Ollama (embeddings)
```

1. User creates/edits document in TipTap editor
2. Frontend PATCHes document via API
3. API saves content + version to PostgreSQL
4. API enqueues embedding job to Redis
5. Background worker fetches document, chunks text, generates vector via Ollama
6. Worker stores vector in pgvector column

Search queries run hybrid: full-text (tsvector) + semantic (pgvector cosine).

## Module Boundaries

- `api/` imports from `lib/` and `embedding/` — never the reverse
- `embedding/` imports from `lib/` only
- `lib/` has no imports from `api/` or `embedding/`
- `packages/db/` is imported by both backend and has no dependencies on either

## Security Model

- **Data isolation**: every query filters by `ownerId` (user-scoped)
- **Auth**: Better Auth session cookies (7-day expiry)
- **Sharing**: token-based links with optional password + expiry
- **Rate limiting**: 10 req/min per IP on public share endpoints
- **Validation**: Zod schemas on all API inputs
- **No secrets in code**: all config via environment variables
