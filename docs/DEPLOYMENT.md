# Deployment Guide

## Quick Start (Docker Compose)

```bash
git clone https://github.com/hiai-gg/hiai-docs.git
cd hiai-docs
cp .env.example .env
# Edit .env with your values (see Environment Variables below)

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
| `DATABASE_URL` | Yes | `postgresql://hiai_app:changeme@localhost:5437/hiai_docs` | PostgreSQL connection string (encodes host, port, user, password, db) |
| `REDIS_URL` | Yes | `redis://localhost:6384` | Redis connection URL. **Host/macOS:** use `redis://localhost:6384`. **Docker Compose:** the default compose file overrides this to `redis://redis:6379` (container DNS name, internal port 6379) so the api container can reach redis via the Docker network. |
| `BETTER_AUTH_SECRET` | **Yes** | — | Random 32+ char string |
| `BETTER_AUTH_URL` | Yes | `http://localhost:50700` | Public API URL |
| `STORAGE_ENDPOINT` | No | `localhost` | SeaweedFS host |
| `STORAGE_PORT` | No | `9020` | SeaweedFS port |
| `STORAGE_ACCESS_KEY` | Yes | `minioadmin` | SeaweedFS access key |
| `STORAGE_SECRET_KEY` | Yes | `change-me-to-random-32-chars` | SeaweedFS secret key |
| `STORAGE_BUCKET` | Yes | `hiai-docs` | SeaweedFS bucket name |
| `EMBEDDING_BASE_URL` | If embeddings enabled | — | Base URL for OpenAI-compatible embedding API |
| `EMBEDDING_API_KEY` | If embeddings enabled | — | API key for embedding provider |
| `EMBEDDING_MODEL` | No | — | Model name for embeddings |
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
| `GRAPH_EXTRACT_ENABLED` | No | `false` | Enable LLM entity extraction into Apache AGE |
| `GRAPH_SEARCH_ENABLED` | No | `false` | Enable graph-neighbor expansion in search |
| `GRAPH_EXTRACT_BASE_URL` | If extraction enabled | — | OpenAI-compatible chat-completion URL for entity extraction LLM |
| `GRAPH_EXTRACT_API_KEY` | If extraction enabled | — | API key for extraction LLM |
| `GRAPH_EXTRACT_MODEL` | No | `EMBEDDING_MODEL` | Extraction model name |
| `GRAPH_EXTRACT_MIN_CONFIDENCE` | No | `0.5` | Minimum entity confidence threshold (0.0–1.0) |
| `GRAPH_EXPANSION_BOOST` | No | `0.3` | Multiplier on graph-neighbor discovery scores (0–2) |

### Hybrid Search Weights

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HYBRID_TEXT_WEIGHT` | No | `0.4` | Weight for full-text search score |
| `HYBRID_SEMANTIC_WEIGHT` | No | `0.6` | Weight for semantic cosine score |

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
| `EMBEDDING_FALLBACK_BASE_URL` | No | — | Fallback embedding provider base URL |
| `EMBEDDING_FALLBACK_API_KEY` | No | — | Fallback embedding provider API key |
| `EMBEDDING_FALLBACK_MODEL` | No | — | Fallback embedding model name |

### Fallback GraphRAG Extraction

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GRAPH_EXTRACT_FALLBACK_BASE_URL` | No | — | Fallback extraction LLM base URL |
| `GRAPH_EXTRACT_FALLBACK_API_KEY` | No | — | Fallback extraction LLM API key |
| `GRAPH_EXTRACT_FALLBACK_MODEL` | No | — | Fallback extraction model name |

### SeaweedFS Public Endpoint

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STORAGE_PUBLIC_ENDPOINT` | No | `localhost` | Public SeaweedFS host (used for presigned attachment URLs) |
| `STORAGE_PUBLIC_PORT` | No | `9020` | Public SeaweedFS port |

> **⚠️ Secret hygiene:** All secrets in `.env.example` use `change-me` placeholders with `CHANGE-ME` markers. Run `openssl rand -hex 32` to generate values for `BETTER_AUTH_SECRET`, `CSRF_SECRET`, `WEBHOOK_SECRET`, and `HIAI_DOCS_API_KEY`. The `OWNER_ID` should be your first registered user's UUID from the auth system. Never commit real secrets to `.env.example` or documentation.

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

```bash
# Generate migration from schema changes
cd packages/db && bun run db:generate

# Apply migration
bun run db:migrate

# Push schema directly (dev only)
bun run db:push
```

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
