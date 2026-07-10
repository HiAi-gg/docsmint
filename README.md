# hiai-docs

**The lightest AI-native self-hosted knowledge vault.**

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/hiai-gg/hiai-docs?sort=semver)](https://github.com/hiai-gg/hiai-docs/releases)
[![Stars](https://img.shields.io/github/stars/hiai-gg/hiai-docs)](https://github.com/hiai-gg/hiai-docs/stargazers)
[![CI](https://github.com/hiai-gg/hiai-docs/actions/workflows/ci.yml/badge.svg)](https://github.com/hiai-gg/hiai-docs/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/Runtime-Bun_1.3-black?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Svelte](https://img.shields.io/badge/Svelte-5.x-FF3E00?logo=svelte&logoColor=white)](https://svelte.dev)
[![Elysia](https://img.shields.io/badge/Elysia-1.4-lightgrey?logo=elysia&logoColor=white)](https://elysiajs.com)
[![Tailwind_CSS](https://img.shields.io/badge/Tailwind_CSS-v4-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Drizzle_ORM](https://img.shields.io/badge/Drizzle_ORM-0.45-C5F74F?logo=drizzle&logoColor=black)](https://orm.drizzle.team)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

hiai-docs is a lightweight **self-hosted knowledge base** built for users who want speed, full data ownership, and strong AI capabilities without heavy enterprise overhead.

If you are looking for a **local LLM knowledge base** or a **lightweight Outline alternative** / **Docmost alternative**, hiai-docs offers an elegant, **RAG-ready knowledge vault** that automatically generates vector embeddings on every save, supports hybrid semantic search, and provides a clean REST API for AI agent integration.

---

## Table of Contents

- [Features](#features)
- [Screenshots](#screenshots)
- [GraphRAG (optional)](#graphrag-optional)
- [Quick Start](#quick-start)
- [Stack](#stack)
- [Comparison](#comparison-with-other-self-hosted-solutions)
- [Project Structure](#project-structure)
- [Configuration](#configuration)
- [Embedding Lifecycle](#embedding-lifecycle)
- [API Documentation](#api-documentation)
- [Admin API](#admin-api)
- [Contributing](#contributing)
- [License](#license)
- [Related Projects](#related-projects)

---

<img width="1920" height="974" alt="docs" src="https://github.com/user-attachments/assets/94701d01-a361-4ca1-b16d-de2a0c64d684" />


## Key Features

- **Smart Re-embed System** — automatic vector refresh on metadata changes (tags, folders, categories) with Redis-deduplicated batch processing to prevent embedding storms
- **Incremental Chunk Updates** — hash-based chunk comparison ensures only changed content is re-embedded; overlap regions maintain semantic continuity
- **GraphRAG with Apache AGE** — optional entity extraction and graph-based search expansion for discovering related documents beyond vector similarity
- **Hybrid Search** — configurable full-text + semantic search with tunable weights (`HYBRID_TEXT_WEIGHT`, `HYBRID_SEMANTIC_WEIGHT`)
- **Chunk Versioning** — `embedding_model` column tracks which model produced each vector, enabling targeted reindex operations when models change
- **Admin Tooling** — `/api/admin/*` endpoints for reindexing, embedding stats, provider health checks, and AGE inventory queries
- **Operator Controls** — `ADMIN_CROSS_TENANT` flag and `?ownerId=` parameter for multi-tenant deployments

## Features

- **Rich WYSIWYG editor** — powerful visual editing with TipTap v3 + svelte-tiptap
- **AI-native** — automatic chunking + vector embeddings on every save, with folder / tag / category metadata enriched into the chunk text for sharper semantic recall
- **Unified search stack** — `pgvector` for dense embeddings, `pgvectorscale` StreamingDiskANN with binary quantization for index speed and recall, and Apache AGE for graph expansion, all living in a single PostgreSQL 18 database. Hybrid ranking = full-text + semantic + graph-neighbor boost; optional `includeChunks` returns top-3 chunk snippets with character-offset tracking
- **System-wide re-embed** — every metadata mutation (tag / folder / category rename or delete) automatically refreshes affected vectors, with Redis-coalesced PATCH-storm dedup so rapid edits never spike embedding costs
- **GraphRAG (optional)** — entity extraction + AGE graph expansion surfaces related documents beyond vector similarity, gated by feature flags and fully off by default
- **Categories** — collapsible sidebar groups that classify folders and documents independently of the folder hierarchy, filterable from the search page
- **Folder hierarchy** — nested folders to organize your documents
- **Keyboard-first** — `Ctrl+K` QuickSearch, `?` ShortcutHelp, editor shortcuts (`Ctrl+Shift+7` toggle markdown, `Ctrl+Shift+E` export), and `Esc` to close any dialog
- **Sharing** — token-protected links with password, expiration, and viewer/commenter/editor roles
- **Multi-file import** — drag in many `.md` / `.txt` / `.markdown` / `.json` / `.docx` files at once with a per-file progress overlay
- **API Keys** — create, list, and revoke user-scoped API keys with Bearer auth for programmatic access
- **Document visibility** — per-document public/private/shared visibility with RLS-enforced access control
- **Plugin Registry** — REST API for discovering available editor plugins
- **Agent-ready** — clean REST API for AI agents (Mastra compatible and others) plus an MCP server
- **Operator tooling** — admin endpoints for embedding-stats, provider health, targeted reindex, AGE inventory, and graph index introspection
- **Audit trail** — append-only audit log recording document, share, and API key lifecycle events
- **Self-hosted** — full data ownership with minimal resource usage

## Screenshots
<img width="999" height="594" alt="docs_screenshot" src="https://github.com/user-attachments/assets/1ba409e7-32cf-40d3-ae30-f8369e48cb53" />

---

## Search stack

Three indexes on the same `document_embeddings` table, all in one database. Pick the right one for the workload.

| Access method | Extension | When to use |
|---|---|---|
| `hnsw` | `pgvector` (default) | < 100k rows, low latency, simple ops |
| `ivfflat` | `pgvector` | < 10k rows, training cost amortized, very small memory |
| `diskann` | `pgvectorscale` (StreamingDiskANN) | 100k+ rows, larger-than-RAM, SbqCompression for ~10x storage reduction |

The current Docker image ships with all three pre-installed. To switch, replace the `USING` clause in your index DDL:

```sql
-- HNSW (default)
CREATE INDEX ON document_embeddings
  USING hnsw (embedding vector_cosine_ops);

-- DiskANN (StreamingDiskANN with binary quantization)
CREATE INDEX ON document_embeddings
  USING diskann (embedding vector_cosine_ops);
```

**Search ranking** is a weighted sum of the three signals:

```
score = HYBRID_TEXT_WEIGHT * full_text_score
      + HYBRID_SEMANTIC_WEIGHT * semantic_cosine
      + (graph_neighbors) * GRAPH_EXPANSION_BOOST
```

Defaults: `0.4` text, `0.6` semantic, `0.3` graph boost. With `?graph=true&graphHops=N` (1-3), graph neighbors that aren't in the merged set are inserted with a fixed `GRAPH_EXPANSION_BOOST * 1.0` score; neighbors that are already present get the same factor multiplied onto their existing score.

---

## GraphRAG (optional)

GraphRAG layers a knowledge graph over the existing vector search. It is optional and off by default — the rest of hiai-docs works exactly the same when GraphRAG is disabled.

### When to enable it

- Your corpus is small but rich in entity relationships (people, projects, concepts cross-referenced across documents).
- You want search results to surface *related* documents, not just exact and near-exact matches.

### How it works

1. **Extraction** — when `GRAPH_EXTRACT_ENABLED=true`, the embedding worker calls an OpenAI-compatible chat-completion API after every successful embed. The LLM extracts entities and relations from each chunk; entities with confidence >= `GRAPH_EXTRACT_MIN_CONFIDENCE` (default `0.5`) are persisted to Apache AGE as graph nodes and edges.
2. **Search** — when `GRAPH_SEARCH_ENABLED=true`, `GET /api/search?graph=true` walks the graph from each merged seed document (1-3 hops, controlled by `?graphHops=N`). Discovered neighbors are merged into the result list with a multiplicative boost of `GRAPH_EXPANSION_BOOST` (default `0.3`).
3. **Operator tooling** — `GET /api/admin/graph/stats` reports current AGE inventory (node and edge counts).

> **✅ GraphRAG status:** All GraphRAG audit findings (G1–G9, N1) are resolved. GraphRAG remains **optional and off by default** — it requires an AGE-enabled PostgreSQL instance and explicit `GRAPH_EXTRACT_BASE_URL` configuration for production use. See [GraphRAG Infrastructure Audit](docs/GRAPHRAG_AUDIT.md) for the full resolution log.

### Where AGE lives

Apache AGE runs in the **same PostgreSQL database** as the rest of the application. There is no separate container or connection string — the embedding worker and search route share the Drizzle client from `lib/db.ts` and dispatch `cypher()` queries against the shared `docs_graph` property graph. See `postgres/Dockerfile` for the unified image.

### Required env vars

```
GRAPH_EXTRACT_ENABLED=false   # default — set to true to enable extraction
GRAPH_SEARCH_ENABLED=false    # default — set to true to enable graph search
GRAPH_EXPANSION_BOOST=0.3      # graph-neighbor boost (0..2)
GRAPH_EXTRACT_BASE_URL=        # OpenAI-compatible chat-completion URL (REQUIRED — do not rely on EMBEDDING_BASE_URL fallback)
GRAPH_EXTRACT_API_KEY=
GRAPH_EXTRACT_MODEL=           # defaults to EMBEDDING_MODEL when unset
GRAPH_EXTRACT_REASONING_EFFORT= # optional; use none for Ollama Qwen3
GRAPH_EXTRACT_TIMEOUT_MS=120000 # allows cold local-model loads
GRAPH_EXTRACT_MIN_CONFIDENCE=0.5
```

See [`.env.example`](.env.example) for the full set, including optional `GRAPH_EXTRACT_FALLBACK_*` mirrors.
## Quick Start

### Option 1: Docker (run the full product)

```bash
git clone https://github.com/hiai-gg/hiai-docs.git
cd hiai-docs
cp .env.example .env
# Edit .env with your settings

docker compose up -d
```

> **Note:** To enable the Caddy reverse proxy (TLS, production), run with `--profile caddy`:
> `docker compose --profile caddy up -d`

Open http://localhost:50701

### Option 2: npm — SDK, CLI, and MCP server

Installing via npm gives you three agent-facing tools. It does **not** deploy hiai-docs —
you still need a running instance (Docker or git clone).

```bash
bun add @hiai-gg/hiai-docs
# or: npm install @hiai-gg/hiai-docs
```

**TypeScript / JavaScript SDK:**

```ts
import { DocsClient } from "@hiai-gg/hiai-docs";

const docs = new DocsClient({
  baseUrl: process.env.HIAI_DOCS_URL ?? "http://localhost:50700",
  apiKey: process.env.HIAI_DOCS_API_KEY ?? "",
});

const { items } = await docs.listDocs({ limit: 20 });
const results = await docs.search("quarterly planning");
const doc = await docs.createDoc({ title: "Meeting notes", content: "# Agenda" });
```

**CLI (terminal):**

```bash
bunx @hiai-gg/hiai-docs init              # configure URL + API key
bunx @hiai-gg/hiai-docs search "pgvector" # search docs
bunx @hiai-gg/hiai-docs list              # list documents
bunx @hiai-gg/hiai-docs read <id>         # read a document
bunx @hiai-gg/hiai-docs create --title "Notes" --content "# Hello"
```

**MCP server (Claude Desktop, Cursor, etc.):**

```bash
bunx @hiai-gg/hiai-docs-mcp               # run the MCP server
```

**What's in the package:**

| What | How to use |
|------|-----------|
| `import { DocsClient }` | TypeScript/JS SDK — typed HTTP client |
| `import { documents } from "@hiai-gg/hiai-docs/schema"` | Drizzle table definitions |
| `bunx @hiai-gg/hiai-docs <cmd>` | Terminal CLI (12 commands) |
| `bunx @hiai-gg/hiai-docs-mcp` | MCP server (10 tools for AI agents) |

The SDK has **no runtime dependencies** — it uses the platform `fetch` built into Bun, Node 18+, and modern browsers.

#### Subpath imports for advanced integration

The npm package exposes deep imports for consumers who want to reuse hiai-docs infrastructure (DB client, RLS tenant context, Redis/SeaweedFS factories) without coupling to hiai-docs' own `.env` validation:

```ts
// RLS-tenant-scoped DB queries (from shared package)
import { withTenant, adminTenantContext } from "@hiai-gg/hiai-docs/db/with-tenant";

// Drizzle DB client
import { db } from "@hiai-gg/hiai-docs/db/client";
import { documents, folders } from "@hiai-gg/hiai-docs/schema";

// Pure factories — no hiai-docs config dependency (ideal for docsmint / external consumers)
import { createRedis, type RedisConfig } from "@hiai-gg/hiai-docs/backend/lib/redis";
import { createObjectStorageClient, ensureBucket, type ObjectStorageConfig } from "@hiai-gg/hiai-docs/backend/lib/storage";

// Example: create your own Redis/SeaweedFS instance with custom config
const redis = createRedis({ url: "redis://localhost:6384", maxRetriesPerRequest: 3 });
const storage = createObjectStorageClient({ endpoint: "localhost", port: 9020, accessKey: "minioadmin", secretKey: "change-me", useSSL: false, region: "us-east-1", forcePathStyle: true });
```

> **Note:** `backend/lib/redis` and `backend/lib/storage` resolve to the pure factory files (`redis-factory.ts`, `storage-factory.ts`). Importing from `backend/lib/redis.ts` or `backend/lib/storage.ts` directly is also supported and equivalent — both re-export from the factory. The `packages/db/with-tenant` path goes through a re-export shim at `backend/src/lib/with-tenant.ts`.

## Agentic Quickstart (AI-Powered Setup)

Don't want to run setup commands manually? Copy-paste this unified prompt into your AI assistant (OpenCode, Claude Code, Cursor, Copilot, etc.) and let it do the work:

```text
Set up and launch the hiai-docs project on my local system:
1. Clone the repository at https://github.com/hiai-gg/hiai-docs (if not already cloned)
2. Copy .env.example to .env
3. Generate a secure random auth secret using openssl or a secure generator, and set it as BETTER_AUTH_SECRET in .env
4. Install all dependencies with "bun install"
5. Boot up the developer Docker container dependencies (Postgres, Redis, SeaweedFS) by running:
    bun run docker:dev
6. Generate and apply database migrations to setup schemas by running:
   bun run db:push
7. Spin up the application services (Elysia API and SvelteKit web) in development/watch mode:
   bun run dev
8. Verify health status by checking:
   - SvelteKit Web UI: http://localhost:50701
   - Elysia API Health: http://localhost:50700/api/health
```

### Local Development (Recommended for hacking)

Two equivalent workflows — pick one. Both give you live-reload at http://localhost:50701.

#### Option A — Hybrid (infra in Docker, api+web on host)

This is the fastest dev loop. `bun run dev` runs `vite dev` (port 50701) and `bun --watch` for the api in parallel; both auto-reload on file changes.

```bash
# 1. Install JS deps once
bun install

# 2. Start infrastructure in Docker
bun run docker:dev          # brings up postgres, redis, seaweedfs

# 3. Push DB schema (one-time, or after schema changes)
bun run db:push

# 4. Start api + web on the host, with live reload
bun run dev
# vite dev -> http://localhost:50701
# api      -> http://localhost:50700
```

Stop the infra when done: `bun run stop`

#### Option B — Full Docker with live-reload bind mounts

`docker-compose.dev.yml` mounts the source into the api/web containers, so editing a file on the host is picked up inside the container (vite HMR + bun --watch). Useful when you want everything isolated in Docker.

```bash
bun run docker:dev
# Open http://localhost:50701
```

> The `web` and `api` services in `docker-compose.dev.yml` bind `./:/app`, so any edit on the host is reflected inside the container without rebuilding.

### Why is port 50701 special?

The frontend dev server is pinned to port 50701 in `frontend/vite.config.ts` with `strictPort: true`. That last flag is important: if 50701 is already taken (e.g. a stale container from a previous run), vite will **fail loudly** instead of silently falling back to 5173 — which would leave you staring at an old build at http://localhost:50701. If you see "port 50701 in use", run `docker compose down` (or `bun run stop`) and retry.

### Troubleshooting

#### Docker: permission denied

If you get `permission denied` when running Docker commands:

```bash
# Add your user to the docker group
sudo usermod -aG docker $USER

# Log out and back in, or run:
newgrp docker
```

Then verify: `docker ps` should work without `sudo`.

- **Port 50701 already in use** — `docker compose down` to stop stale containers, then retry `bun run dev` or `bun run docker:dev`.
- **Changes not showing up** — `bun run dev` already wires HMR. If running via Docker, confirm the bind mount is in `docker-compose.dev.yml` (not the prod `docker-compose.yml`, which builds an immutable image).
- **`bun install` complains about the lockfile** — ensure `bun.lock` is in sync: `bun install`.
- **Docker `web` build works without paraglide patches** — As of `@inlang/paraglide-js@2.x`, the `@inlang/sdk@2.x` rewrite no longer emits the `data:` URLs that triggered Bun's `NameTooLong` error. The old `sed` patch on `frontend/Dockerfile` was removed. i18n is now driven by `@inlang/paraglide-js@2.x` directly (the SvelteKit adapter is deprecated) via `paraglideVitePlugin` in `vite.config.ts` and `paraglideMiddleware` in `src/hooks.server.ts`.
- **GraphRAG queries return `available: false`** — confirm `GRAPH_EXTRACT_ENABLED` or `GRAPH_SEARCH_ENABLED` is `true` AND the `age` extension is installed in the shared PostgreSQL database (the unified `hiai-postgres` image ships with it; check `SELECT extname, extversion FROM pg_extension` to verify).

---

## Stack

| Layer | Technology |
|-------|----------|
| Runtime | [Bun](https://bun.sh) 1.3.14+ |
| Backend | [Elysia](https://elysiajs.com) 1.4.28+ |
| ORM | [Drizzle ORM](https://orm.drizzle.team) 0.45.2+ |
| Database | [PostgreSQL](https://postgresql.org) 18 + [pgvector](https://github.com/pgvector/pgvector) |
| Graph database (optional) | [Apache AGE](https://age.apache.org) 1.7.0 (lives in the same PostgreSQL 18 instance) |
| Vector index (optional) | [pgvectorscale](https://github.com/timescale/pgvectorscale) 0.9.0 — StreamingDiskANN with SbqCompression |
| Cache | [Redis](https://redis.io) 8.6+ |
| Auth | [Better Auth](https://better-auth.com) |
| Frontend | [SvelteKit](https://kit.svelte.dev) 2.60+ |
| UI | [shadcn-svelte](https://shadcn-svelte.com) (new-york style) |
| Editor | [svelte-tiptap](https://github.com/sibiraj-s/svelte-tiptap) + [TipTap v3](https://tiptap.dev) |
| Embeddings | OpenAI-compatible API (configurable) |
| Storage | [SeaweedFS](https://github.com/seaweedfs/seaweedfs) (S3-compatible) |

---

## Comparison with other self-hosted solutions

| Project            | Best For                              | hiai-docs vs them                              | License / Limitations                          |
|--------------------|---------------------------------------|------------------------------------------------|------------------------------------------------|
| **La Suite Docs**  | Government & teams, strong block editor | Much lighter and faster                        | MIT (fully unrestricted)                       |
| **Outline**        | Teams with integrations               | Lighter + built-in RAG out of the box          | BSL 1.1 – free for self-hosting, restrictions on offering as hosted service |
| **Docmost**        | Confluence / Notion replacement       | Simpler, faster, lower resource usage          | AGPL-3.0 (Community) – fully open, Enterprise features extra |
| **Wiki.js**        | Markdown + Git sync                   | Better AI & semantic search                    | AGPL-3.0                                       |
| **hiai-docs**      | **Lightweight AI-first vault**        | —                                              | MIT (fully unrestricted)                       |
| **AFFiNE**         | Notion + whiteboard experience        | Much lighter, far lower overhead               | MIT (frontend) + restrictive EE license (backend) – production limits (10 users / 100 GB on free tier) |
| **Trilium Notes**  | Personal knowledge + scripting        | Better sharing & semantic search               | AGPL-3.0                                       |
| **SilverBullet**   | Extensible Markdown notes             | Better AI integration & sharing                | MIT                                            |

**hiai-docs** sits in the **lightweight AI-first** niche — ideal when you want built-in embeddings, fast performance, and minimal resource consumption rather than heavy collaboration features or enterprise complexity.

---

## Project Structure

```
hiai-docs/
├── backend/              # Elysia REST API
│   ├── src/
│   │   ├── api/          # Routes + middleware
│   │   ├── lib/          # Shared utilities
│   │   │   ├── redis-factory.ts   # Pure createRedis(cfg) factory
│   │   │   ├── storage-factory.ts   # Pure createObjectStorageClient(cfg) + ensureBucket() factory
│   │   │   ├── redis.ts           # Singleton re-export wrapper (→ redis-factory)
│   │   │   ├── storage.ts         # Singleton re-export wrapper (→ storage-factory)
│   │   │   ├── with-tenant.ts     # Re-export shim (→ packages/db/src/with-tenant)
│   │   │   └── reembed.ts         # Smart re-embed entry point
│   │   ├── embedding/    # Embedding pipeline
│   │   └── index.ts      # Entry point
│   ├── package.json
│   └── tsconfig.json
├── frontend/             # SvelteKit web UI
│   ├── src/
│   │   ├── routes/       # Pages
│   │   ├── lib/          # Components + utils
│   │   └── app.css       # Tailwind + theme
│   ├── package.json
│   └── svelte.config.js
├── packages/db/          # Drizzle schema + migrations
│   ├── src/
│   │   ├── schema.ts     # Table definitions
│   │   ├── client.ts     # Drizzle client instance
│   │   ├── with-tenant.ts # RLS context (withTenant, TenantContext, adminTenantContext)
│   │   ├── migrations/   # SQL migrations
│   │   └── index.ts      # Re-exports
│   └── package.json
├── postgres/             # Custom PostgreSQL image (pgvector + vectorscale + age) — see postgres/Dockerfile
├── docker-compose.yml    # Production Docker setup
├── .env.example          # Environment template
├── AGENTS.md             # Agent instructions
├── README.md             # This file
├── LICENSE               # MIT
└── todo.md               # Development roadmap
```

---

## Configuration

All configuration via environment variables. Copy `.env.example` to `.env` and configure:

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | postgresql://hiai_app:changeme@localhost:5437/hiai_docs | PostgreSQL connection string |
| `REDIS_URL` | redis://localhost:6384 | Redis connection URL |
| `BETTER_AUTH_SECRET` | — | Auth secret (generate random) |
| `BETTER_AUTH_URL` | http://localhost:50700 | Auth base URL |
| `CSRF_SECRET` | — | CSRF signing secret |
| `WEBHOOK_SECRET` | — | Webhook HMAC secret |
| `STORAGE_ENDPOINT` | localhost | SeaweedFS host |
| `STORAGE_PORT` | 9020 | SeaweedFS port |
| `STORAGE_PUBLIC_ENDPOINT` | localhost | Public SeaweedFS host (for presigned URLs) |
| `STORAGE_PUBLIC_PORT` | 9020 | Public SeaweedFS port |
| `STORAGE_ACCESS_KEY` | minioadmin | SeaweedFS access key |
| `STORAGE_SECRET_KEY` | minioadmin | SeaweedFS secret key |
| `STORAGE_BUCKET` | hiai-docs | SeaweedFS bucket name |
| `EMBEDDING_BASE_URL` | — | Base URL for OpenAI-compatible embedding API (optional) |
| `EMBEDDING_API_KEY` | — | API key for embedding service (leave empty for local inference) |
| `EMBEDDING_MODEL` | — | Embedding model name |
| `EMBEDDING_FALLBACK_BASE_URL` | — | Fallback embedding URL |
| `EMBEDDING_FALLBACK_API_KEY` | — | Fallback embedding API key |
| `EMBEDDING_FALLBACK_MODEL` | — | Fallback embedding model |
| `CORS_ORIGINS` | http://localhost:50701 | Comma-separated allowed origins (required for local dev) |
| `GRAPH_EXTRACT_ENABLED` | false | Enable LLM entity extraction into AGE |
| `GRAPH_SEARCH_ENABLED` | false | Enable graph-neighbor expansion in search |
| `GRAPH_EXPANSION_BOOST` | 0.3 | Multiplier on graph-neighbor scores (0..2) |
| `GRAPH_EXTRACT_BASE_URL` | — | Chat-completion URL for entity extraction LLM |
| `GRAPH_EXTRACT_API_KEY` | — | API key for entity extraction LLM |
| `GRAPH_EXTRACT_MODEL` | — | Entity extraction model (defaults to EMBEDDING_MODEL) |
| `GRAPH_EXTRACT_REASONING_EFFORT` | — | Optional reasoning control; use `none` for Ollama Qwen3 |
| `GRAPH_EXTRACT_TIMEOUT_MS` | 120000 | Entity extraction request timeout; accommodates cold local models |
| `GRAPH_EXTRACT_MIN_CONFIDENCE` | 0.5 | Minimum entity confidence threshold |
| `GRAPH_EXTRACT_FALLBACK_BASE_URL` | — | Fallback extraction LLM URL |
| `GRAPH_EXTRACT_FALLBACK_API_KEY` | — | Fallback extraction LLM API key |
| `GRAPH_EXTRACT_FALLBACK_MODEL` | — | Fallback extraction model |
| `FOLDER_REEMBED_BATCH_SIZE` | 100 | Cap on docs re-embedded per folder mutation |
| `CATEGORY_REEMBED_BATCH_SIZE` | 100 | Cap on docs re-embedded per category mutation |
| `TAG_REEMBED_BATCH_SIZE` | 500 | Cap on docs re-embedded per tag mutation |
| `REEMBED_MIN_WORD_CHANGES` | 20 | Min word-change delta to trigger re-embed |
| `REEMBED_MIN_CHAR_CHANGES` | 100 | Min char-change delta to trigger re-embed |
| `REEMBED_MAX_IDLE_HOURS` | 24 | Max hours before forced re-embed eligibility |
| `REEMBED_CRON_INTERVAL_MINUTES` | 15 | Content re-embed cron frequency |
| `METADATA_REEMBED_CRON_INTERVAL_MINUTES` | 1 | Metadata re-embed cron frequency |
| `VERSION_RETENTION_COUNT` | 50 | Auto-saved version history size per document |
| `ADMIN_CROSS_TENANT` | true | Allow cross-tenant admin operations |
| `ATTACHMENT_MAX_SIZE_MB` | 25 | Max attachment upload size in MB |
| `ATTACHMENT_PRESIGN_EXPIRY_SECONDS` | 900 | Presigned URL lifetime (seconds) |

See [`.env.example`](.env.example) for the full list with comments and defaults.

---

## Embedding Lifecycle

Every document save triggers an embedding pipeline that produces chunk-level vectors and (optionally) graph entities. The pipeline is best-effort — failures never block document saves, but they do leave stale vectors that the operator must refresh explicitly.

### When re-embed fires automatically

| Trigger | Behavior |
|---------|----------|
| Document create / update (content or title change) | Hash-aware incremental re-embed via `enqueueReembed`; changed chunks and their overlap neighbors are re-embedded, unchanged chunks keep their vectors |
| Tag rename | All documents carrying the tag re-embed via `reembedDocsByTag` |
| Tag delete | All documents carrying the tag re-embed |
| Tag added / removed from a document | That document re-embeds |
| Folder rename / delete | All documents in the folder re-embed via `reembedDocsInFolder` |
| Category rename / delete | All documents directly attached to the category, plus documents in folders attached to it, re-embed via `reembedDocsInCategory` |

The single entry point is `backend/src/lib/reembed.ts`. All helpers coalesce rapid PATCH / auto-save / toggle storms via a Redis `SET NX EX 5` dedup slot — a burst of rapid PATCHes on the same document results in a single worker tick.

### Batch caps

Each metadata-triggered re-embed is bounded by an env var so a rename of a mega-folder cannot spike embedding costs in a single tick. Remaining documents are refreshed on their next edit.

| Env var | Default | Scope |
|---------|---------|-------|
| `FOLDER_REEMBED_BATCH_SIZE` | `100` | `reembedDocsInFolder` |
| `CATEGORY_REEMBED_BATCH_SIZE` | `100` | `reembedDocsInCategory` |
| `TAG_REEMBED_BATCH_SIZE` | `500` | `reembedDocsByTag` |

Set any of these to `0` to disable the cap (re-embed everything in a single tick — not recommended for production with more than 10k documents per folder).

### Manual reindex (operator)

Use the admin endpoints for bulk re-embed that does not fit the metadata-trigger surface:

```bash
# Preview affected docs before committing (always do this first)
curl -X POST -H "x-api-key: $HIAI_DOCS_API_KEY" \
  "http://localhost:50700/api/admin/reindex/model?dryRun=true"

# Commit: re-embed every doc whose stored embedding_model does not match the current EMBEDDING_MODEL
curl -X POST -H "x-api-key: $HIAI_DOCS_API_KEY" \
  "http://localhost:50700/api/admin/reindex/model"

# Bulk re-embed a folder or tag
curl -X POST -H "x-api-key: $HIAI_DOCS_API_KEY" \
  "http://localhost:50700/api/admin/reindex/folder/$FOLDER_ID"
curl -X POST -H "x-api-key: $HIAI_DOCS_API_KEY" \
  "http://localhost:50700/api/admin/reindex/tag/$TAG_ID"

# Force re-embed a single doc
curl -X POST -H "x-api-key: $HIAI_DOCS_API_KEY" \
  "http://localhost:50700/api/admin/reindex/$DOC_ID"
```

All admin endpoints support `?dryRun=true` to return the affected count without enqueuing. See [docs/API.md](docs/API.md#admin) for the full surface.

---

## API Documentation

REST API available at `http://localhost:50700/api/`.

Key endpoints:
- `POST /api/documents` — Create document
- `GET /api/documents/:id` — Get document with tags
- `GET /api/search?q=query` — Hybrid full-text + semantic search
- `GET /api/search?graph=true&graphHops=2&graphBoost=0.3` — Graph-augmented search (requires `GRAPH_SEARCH_ENABLED=true`)
- `POST /api/share` — Create share link
- `GET /api/share/:token` — Access shared content (public)
- `POST /api/documents/:id/attachments` — Upload image
- `WS /ws/collab/:documentId` — Real-time collaborative editing

Full API documentation available in [docs/API.md](docs/API.md).

---

## Admin API

The admin surface at `/api/admin` provides operator-only endpoints for embedding pipeline observability, bulk reindex, and graph inventory. All endpoints require the static `HIAI_DOCS_API_KEY` via the `x-api-key` header (or `Authorization: Bearer`).

| Endpoint | Purpose |
|----------|---------|
| `GET /api/admin/embedding-stats` | Total chunks, distinct docs with embeddings, zero-vector (provider-failed) chunks |
| `GET /api/admin/health/embeddings` | Live probe of the configured embedding provider (returns `ok` / `degraded` / `not-configured`) |
| `POST /api/admin/reindex/:docId` | Force re-embed one document |
| `POST /api/admin/reindex/model?dryRun=true` | Targeted re-embed for embedding-model mismatch |
| `POST /api/admin/reindex/folder/:folderId?dryRun=true` | Bulk re-embed a folder (cross-user, operator scope) |
| `POST /api/admin/reindex/tag/:tagId?dryRun=true` | Bulk re-embed a tag (cross-user, operator scope) |
| `GET /api/admin/graph/stats` | Apache AGE inventory (node and edge counts) |

Full request/response schemas in [docs/API.md](docs/API.md#admin).

### Quick health check

```bash
# Pipeline observability
curl -H "x-api-key: $HIAI_DOCS_API_KEY" http://localhost:50700/api/admin/embedding-stats

# Live provider probe (returns ok / degraded / not-configured)
curl -H "x-api-key: $HIAI_DOCS_API_KEY" http://localhost:50700/api/admin/health/embeddings
```

---

## For Builders: Extension Points

hiai-docs is designed to be extended from the **outside** — without forking the
core repository. These are the stable, supported integration surfaces:

### REST API

Every hiai-docs capability is exposed as a REST endpoint at `http://<host>:50700/api`.
Authenticate with `Authorization: Bearer <HIAI_DOCS_API_KEY>` for server-to-server use,
or use the session cookie from Better Auth for user-facing flows.

Full schema: [docs/API.md](docs/API.md) · OpenAPI JSON: [docs/openapi.json](docs/openapi.json)

### UI Extension Points (submodule customization)

External projects (such as commercial forks using hiai-docs as a Git submodule) can cleanly customize the editor formatting toolbar and register custom document view tabs without modifying core files:

- **Editor Toolbar Snippet**: Inject custom buttons or dropdown menus (e.g. AI draft generation tools).
- **Document View Tabs**: Register new custom tabs (e.g. live HTML preview, metadata dashboards, PDF renderers) next to the default Editor tab.

For step-by-step setup guides, component interfaces, and complete API references, see [docs/EXTENDING.md](docs/EXTENDING.md).


### MCP Server (AI agents)

For AI coding assistants that support the Model Context Protocol (Claude, Cursor, etc.),
use the built-in MCP server directly from npm — no clone required:

```bash
# Run once to verify
bunx @hiai-gg/hiai-docs-mcp
```

Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "hiai-docs": {
      "command": "bunx",
      "args": ["@hiai-gg/hiai-docs-mcp"],
      "env": {
        "HIAI_DOCS_URL": "http://localhost:50700",
        "HIAI_DOCS_API_KEY": "your-api-key"
      }
    }
  }
}
```

Available MCP tools: `search`, `get-document`, `create-document`, `update-document`,
`list-documents`, `list-folders`, `create-folder`, `create-snapshot`, `version-history`, `export-document`.

### Drizzle Schema Import

If your project uses the same PostgreSQL database as hiai-docs and you want to
write typed Drizzle queries against hiai-docs tables:

```ts
import { documents, folders, tags, users } from "@hiai-gg/hiai-docs/schema";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const db = drizzle(postgres(process.env.DATABASE_URL!));
const docs = await db.select().from(documents).limit(10);
```

Requires `drizzle-orm` and `postgres` as peer dependencies in your project.

### Webhook Events

hiai-docs emits webhook events for document lifecycle changes. Configure the
`WEBHOOK_SECRET` and target URL in `.env`. See [docs/API.md](docs/API.md) for
payload shapes.

### What belongs in core vs. downstream

| ✅ Core | ❌ Downstream only |
|--------|-------------------|
| Document CRUD, folders, tags, categories | Product-specific analytics / usage tracking |
| Hybrid search (text + semantic) | Custom embedding providers not in `.env` |
| Sharing, versioning, attachments | White-label UI themes |
| GraphRAG (optional, feature-flagged) | Domain-specific document types |
| Admin / reindex endpoints | Custom auth providers beyond Better Auth |

If a feature requires changes to the Drizzle schema, authentication flow, or core
embedding pipeline, open an issue first to discuss the design.

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing`)
3. Commit changes (`git commit -m "feat: add amazing feature"`)
4. Push to branch (`git push origin feature/amazing`)
5. Open a Pull Request

### Development Rules

- **Bun only** — no npm/yarn
- **ESM only** — no CommonJS
- **TypeScript strict** — no `any`
- **English only** — code, comments, docs, commits
- **No Playwright** — use agent-browser for E2E
- **Re-embed invariant** — metadata mutations route through `backend/src/lib/reembed.ts`

---

## License

[MIT](LICENSE)

---

## Related Projects

Part of the [HiAi](https://hiai.gg) open-source ecosystem:

| Project | Description |
|---------|-------------|
| [hiai-opencode](https://github.com/hiai-gg/hiai-opencode) | AI coding agent |
| [hiai-observe](https://github.com/hiai-gg/hiai-observe) | Observability platform |
