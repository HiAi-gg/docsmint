# Deployment Guide

## Quick Start (Docker Compose)

```bash
git clone https://github.com/hiai-gg/hiai-docs.git
cd hiai-docs
cp .env.example .env
# Paste your OpenRouter key into OPENROUTER_API_KEY, or replace the
# EMBEDDING_* values with the local Ollama example (see below).

docker compose up -d
```

The app will be available at:
- Frontend: `http://localhost:50701`
- API: `http://localhost:50700`
- API Docs: `http://localhost:50700/api/docs`
- SeaweedFS Console: `http://localhost:9021`

## Local Development

```bash
bun install

# Start infrastructure only (use shared ai-core services or local docker)
docker compose -f docker-compose.dev.yml up -d

# Push database schema
cd packages/db && bun run db:push && cd ../..

# Start backend and frontend in separate terminals
cd backend && bun run dev     # → localhost:50700
cd frontend && bun run dev    # → localhost:50701
```

## Environment Variables

Copy `.env.example` and fill in:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL runtime connection string for `hiai_app` |
| `HIAI_APP_PASSWORD` | Yes | — | Unique runtime-role password; generate a hex value with `openssl rand -hex 32` |
| `REDIS_URL` | Yes | `redis://localhost:6384` | Redis connection URL. **Host/macOS:** use `redis://localhost:6384`. **Docker Compose:** the default compose file overrides this to `redis://redis:6379` (container DNS name, internal port 6379) so the api container can reach redis via the Docker network. |
| `BETTER_AUTH_SECRET` | **Yes** | — | Random 32+ char string |
| `BETTER_AUTH_URL` | Yes | `http://localhost:50700` | Public API URL |
| `STORAGE_ENDPOINT` | No | `localhost` | SeaweedFS host |
| `STORAGE_PORT` | No | `9020` | SeaweedFS port |
| `STORAGE_ACCESS_KEY` | Yes | `hiai-docs` | SeaweedFS access key |
| `STORAGE_SECRET_KEY` | Yes | — | SeaweedFS secret key; generate a unique random value |
| `STORAGE_BUCKET` | Yes | `hiai-docs` | SeaweedFS bucket name |
| `OPENROUTER_API_KEY` | For the public default | — | OpenRouter key used by both default embedding providers; never commit a real key |
| `EMBEDDING_BASE_URL` | If embeddings enabled | `https://openrouter.ai/api/v1` | Base URL for the primary OpenAI-compatible embedding API |
| `EMBEDDING_API_KEY` | No | — | Optional provider-specific key; overrides `OPENROUTER_API_KEY` for the primary provider |
| `EMBEDDING_MODEL` | No | `openai/text-embedding-3-small` | Primary embedding model (fixed 1024-dimensional output) |
| `API_PORT` | No | `50700` | Backend port |
| `WEB_PORT` | No | `50701` | Frontend port |
| `NODE_ENV` | No | `production` | `development` or `production` |
| `LOG_LEVEL` | No | `info` | `trace`/`debug`/`info`/`warn`/`error`/`fatal` |
| `CSRF_SECRET` | Yes | — | CSRF protection secret |
| `WEBHOOK_SECRET` | Yes | — | Webhook signature secret |
| `CORS_ORIGINS` | No | `http://localhost:50701` | Comma-separated allowed origins |
| `HIAI_DOCS_API_KEY` | **Yes** | — | Admin API key for `/api/admin/*` endpoints |
| `OWNER_ID` | No | `api-key-user` | Owner user UUID (first registered user from auth); only needed for multi-tenant setups with `ADMIN_CROSS_TENANT=false` |

### GraphRAG Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GRAPH_EXTRACT_ENABLED` | No | `true` in `.env.example`; `false` schema fallback | Extract entities after a complete valid embedding generation |
| `GRAPH_SEARCH_ENABLED` | No | `true` in `.env.example`; `false` schema fallback | Enable automatic graph-neighbor expansion in normal search; operator kill switch |
| `GRAPH_EXTRACT_BASE_URL` | If extraction enabled | `https://openrouter.ai/api/v1` | OpenAI-compatible chat-completion URL for entity extraction LLM |
| `GRAPH_EXTRACT_API_KEY` | If extraction enabled for a custom/non-OpenRouter host | — | Dedicated API key for the extraction LLM; OpenRouter hosts may inherit `OPENROUTER_API_KEY` |
| `GRAPH_EXTRACT_MODEL` | No | `mistralai/ministral-14b-2512` | Primary extraction model |
| `GRAPH_EXTRACT_REASONING_EFFORT` | No | — | OpenAI-compatible reasoning control; use `none` for Ollama Qwen3 |
| `GRAPH_EXTRACT_TIMEOUT_MS` | No | `120000` | Entity extraction request timeout in milliseconds |
| `GRAPH_EXTRACT_MIN_CONFIDENCE` | No | `0.5` | Minimum entity confidence threshold (0.0–1.0) |
| `GRAPH_EXPANSION_BOOST` | No | `0.3` | Legacy multiplier retained for older integrations; current ranking uses RRF and `SEARCH_GRAPH_MAX_CONTRIBUTION` |

### Adaptive Search and RRF

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SEARCH_EXPANSION_ENABLED` | No | `true` | Run one structured multilingual expansion pass when confidence is low |
| `SEARCH_EXPANSION_MODEL` | No | `mistralai/ministral-14b-2512` | Primary expansion model |
| `SEARCH_EXPANSION_FALLBACK_MODEL` | No | `google/gemma-4-31b-it` | Fallback expansion model |
| `SEARCH_EXPANSION_TIMEOUT_MS` | No | `2000` | Expansion timeout |
| `SEARCH_EXPANSION_CACHE_TTL_SECONDS` | No | `86400` | Tenant-scoped expansion cache TTL |
| `SEARCH_EXPANSION_MAX_VARIANTS` | No | `12` | Maximum generated variants per category |
| `SEARCH_EXPANSION_ESTIMATED_COST_MICROUNITS` | No | `0` | Operator-supplied successful-expansion cost estimate for metrics |
| `SEARCH_RRF_K` | No | `60` | Reciprocal rank fusion constant |
| `SEARCH_EXACT_BOOST` | No | `0.02` | Exact/title boost |
| `SEARCH_CHANNEL_AGREEMENT_BOOST` | No | `0.01` | Boost when multiple channels agree |
| `SEARCH_VECTOR_MIN_SIMILARITY` | No | `0.35` | Minimum finite vector similarity |
| `SEARCH_FUZZY_MIN_SIMILARITY` | No | `0.25` | Minimum fuzzy similarity |
| `SEARCH_MIN_CHANNEL_AGREEMENT` | No | `2` | Fast-pass agreement threshold |
| `SEARCH_GRAPH_MAX_CONTRIBUTION` | No | `0.03` | Graph contribution cap in fused ranking |
| `SEARCH_GRAPH_SEED_LIMIT` | No | `10` | Maximum AGE seeds |
| `SEARCH_GRAPH_MAX_HOPS` | No | `2` | AGE traversal depth (1–3) |
| `SEARCH_GRAPH_RESULT_LIMIT` | No | `20` | Maximum graph candidates |

`HYBRID_TEXT_WEIGHT` and `HYBRID_SEMANTIC_WEIGHT` are retained only for compatibility with older clients; the current search path uses exact/title, FTS, fuzzy, vector, expanded, and graph channels fused with RRF.

### Chunking Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CHUNK_TARGET_TOKENS` | No | `500` | Target tokens per chunk |
| `CHUNK_OVERLAP_TOKENS` | No | `50` | Overlap tokens between adjacent chunks |

### Re-Embed Batch Caps

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FOLDER_REEMBED_BATCH_SIZE` | No | `100` | Cap on documents re-embedded per folder mutation |
| `CATEGORY_REEMBED_BATCH_SIZE` | No | `100` | Cap on documents re-embedded per category mutation |
| `TAG_REEMBED_BATCH_SIZE` | No | `500` | Cap on documents re-embedded per tag mutation |

### Attachments

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ATTACHMENT_MAX_SIZE_MB` | No | `25` | Maximum allowed upload size in MB |
| `ATTACHMENT_PRESIGN_EXPIRY_SECONDS` | No | `900` | Presigned URL expiry in seconds (15 minutes) |

### Smart Re-Embed

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REEMBED_MIN_WORD_CHANGES` | No | `20` | Min word-change delta to trigger re-embed |
| `REEMBED_MIN_CHAR_CHANGES` | No | `100` | Min char-change delta to trigger re-embed |
| `REEMBED_MAX_IDLE_HOURS` | No | `24` | Max hours before forced re-embed eligibility |
| `REEMBED_CRON_INTERVAL_MINUTES` | No | `15` | Content re-embed cron frequency (minutes) |
| `METADATA_REEMBED_CRON_INTERVAL_MINUTES` | No | `1` | Metadata re-embed cron frequency (minutes) |

### Version Retention

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VERSION_RETENTION_COUNT` | No | `50` | Number of auto-saved (non-snapshot) versions to retain per document |

### Admin Security

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ADMIN_CROSS_TENANT` | No | `true` | Allow cross-tenant admin operations (set `false` to require explicit `?ownerId=` on admin endpoints) |

### Fallback Embedding

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `EMBEDDING_FALLBACK_BASE_URL` | No | `https://openrouter.ai/api/v1` | Fallback embedding provider base URL |
| `EMBEDDING_FALLBACK_API_KEY` | No | — | Optional fallback-specific key; otherwise `OPENROUTER_API_KEY` is reused |
| `EMBEDDING_FALLBACK_MODEL` | No | `baai/bge-m3` | Fallback embedding model (fixed 1024-dimensional output) |

### Fallback GraphRAG Extraction

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GRAPH_EXTRACT_FALLBACK_BASE_URL` | No | `https://openrouter.ai/api/v1` | Fallback extraction LLM base URL |
| `GRAPH_EXTRACT_FALLBACK_API_KEY` | If fallback uses a custom/non-OpenRouter host | — | Dedicated fallback extraction key; an exact OpenRouter fallback may inherit `OPENROUTER_API_KEY` |
| `GRAPH_EXTRACT_FALLBACK_MODEL` | No | `google/gemma-4-31b-it` | Fallback extraction model name |

### SeaweedFS Public Endpoint

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STORAGE_PUBLIC_ENDPOINT` | No | `localhost` | Public SeaweedFS host (used for presigned attachment URLs) |
| `STORAGE_PUBLIC_PORT` | No | `9020` | Public SeaweedFS port |

> **⚠️ Secret hygiene:** All secrets in `.env.example` use `change-me` placeholders with `CHANGE-ME` markers. Run `openssl rand -hex 32` to generate values for `BETTER_AUTH_SECRET`, `CSRF_SECRET`, `WEBHOOK_SECRET`, and `HIAI_DOCS_API_KEY`. The `OWNER_ID` should be your first registered user's UUID from the auth system. Never commit real secrets to `.env.example` or documentation.

### Embedding provider defaults

The checked-in `.env.example` is ready for a public OpenRouter setup:

```dotenv
OPENROUTER_API_KEY=change-me-paste-your-openrouter-key-here
EMBEDDING_BASE_URL=https://openrouter.ai/api/v1
EMBEDDING_MODEL=openai/text-embedding-3-small
EMBEDDING_FALLBACK_BASE_URL=https://openrouter.ai/api/v1
EMBEDDING_FALLBACK_MODEL=baai/bge-m3
```

Both models are requested with `dimensions=1024`, matching the pgvector schema. The runtime uses `OPENROUTER_API_KEY` for both OpenRouter providers unless an explicit `EMBEDDING_API_KEY` or `EMBEDDING_FALLBACK_API_KEY` is supplied. The shared key is never forwarded to a non-OpenRouter URL. If you prefer local inference, replace both base URLs and model names with an Ollama-compatible 1024-dimensional model (for example `bge-m3`); the Ollama path does not require an API key.

The GraphRAG extraction profile is preconfigured for OpenRouter and is enabled in the copied reference profile:

```dotenv
GRAPH_EXTRACT_ENABLED=true
GRAPH_SEARCH_ENABLED=true
GRAPH_EXTRACT_BASE_URL=https://openrouter.ai/api/v1
GRAPH_EXTRACT_MODEL=mistralai/ministral-14b-2512
GRAPH_EXTRACT_REASONING_EFFORT=none
GRAPH_EXTRACT_FALLBACK_BASE_URL=https://openrouter.ai/api/v1
GRAPH_EXTRACT_FALLBACK_MODEL=google/gemma-4-31b-it
```

Both extraction and graph search are enabled in the copied reference profile because GraphRAG is a core hiai-docs feature. The runtime schema retains fail-safe `false` fallbacks only when no environment file is supplied. For an exact OpenRouter base URL, each extraction provider may inherit `OPENROUTER_API_KEY`; a custom or non-OpenRouter base URL requires its own dedicated `GRAPH_EXTRACT_API_KEY` or `GRAPH_EXTRACT_FALLBACK_API_KEY`. The shared OpenRouter key is never forwarded to a non-OpenRouter URL.

## Production Considerations

### TLS

Use Caddy (included) or a reverse proxy. The default Caddyfile routes:
- `/api/*` → backend
- `/*` → frontend

For custom domains, update `Caddyfile` with your domain.

*Note: Caddy requires the `--profile caddy` flag when running with docker compose.*

### Backups

```bash
# Database
docker compose exec postgres pg_dump -U aiuser hiai_docs > backup.sql

# Restore
cat backup.sql | docker compose exec -T postgres psql -U aiuser -d hiai_docs

# SeaweedFS attachments
docker compose exec seaweedfs ./weed backup /data ./backup-seaweedfs/
```

### Health Checks

```bash
curl -fsS http://localhost:50700/api/health
# → {"status":"ok","timestamp":"..."}
```

## Database Migrations

The custom PostgreSQL image installs the extensions and creates the runtime
role. Drizzle owns all relational and GraphRAG schema objects, including the
single `docs_graph` in the same PostgreSQL database.

```bash
# Generate migration from schema changes
cd packages/db && bun run db:generate

# Apply migrations from the repository root (the runtime image intentionally
# does not contain migration source files)
cd ../.. && bun run db:migrate

# Push schema directly (dev only)
bun run db:push
```

### Generation-aware reindex and relevance benchmark

Run migrations before starting the API on a fresh or upgraded database. The
reindex command is resumable and keeps the previous active generation queryable
until a complete replacement is validated and atomically activated:

```bash
bun run db:migrate
cd backend && bun run src/scripts/reindex-embeddings.ts --dry-run --batch=100
cd backend && bun run src/scripts/reindex-embeddings.ts --batch=100
cd backend && bun run benchmark:search -- --base-url=http://127.0.0.1:50700 --owner-credentials-file=/run/secrets/hiai-docs-benchmark-owners.json
```

The benchmark requires two separate credential scopes. The operator credential
for admin metrics is resolved from `HIAI_DOCS_API_KEY` (or `BENCHMARK_API_KEY`)
via the environment, stdin, or an explicitly configured file. Search probes
require a JSON map keyed by every fixture owner ID; keep that file outside the
repository with restrictive permissions. Safe example (placeholders only):

```json
{
  "owner-a": { "authorization": "Bearer replace-with-owner-a-token" },
  "owner-b": { "cookie": "better-auth.session_token=replace-with-owner-b-session" }
}
```

The command above reads that map from
`/run/secrets/hiai-docs-benchmark-owners.json`. Never pass the operator API key
or an owner credential as an argv value (`--api-key=...` is rejected); argv is
visible to process inspection and shell history. The benchmark fixture checks multilingual recall,
typos, thematic and graph retrieval, explanation labels, invalid-vector
exclusion, expansion coverage, latency, and tenant leakage. Release gates are
Recall@10 ≥ 0.90, MRR@10 ≥ 0.80, zero active invalid vectors, fast p95 ≤ 500 ms,
expanded p95 ≤ 2.5 s, and zero tenant leakage.

Embedding lifecycle states are `pending`, `processing`, `ready`, `failed`, and
`stale`. A document is ready only when its active generation has valid,
finite, non-zero 1024-dimensional rows for every chunk. Graph extraction runs
only after activation; a failed replacement never deletes the last active
generation.

### Secret hygiene

The real OpenRouter key belongs only in `.env` or deployment-secret storage.
Never place it in Git, package tarballs, Docker layers, logs, screenshots,
fixtures, benchmark output, or release notes. The checked-in `.env.example`
contains only the `change-me-paste-your-openrouter-key-here` placeholder.

## Services

| Container | Port | Purpose |
|-----------|------|---------|
| postgres | 5437 | PostgreSQL 18 + pgvector |
| redis | 6384 | Cache/queue |
| seaweedfs | 8333/8888 | S3-compatible file storage |
| api | 50700 | Elysia REST API |
| web | 50701 | SvelteKit frontend |
| caddy | 80/443 | Reverse proxy (auto-TLS) |
*Note: Run with `--profile caddy` flag*
