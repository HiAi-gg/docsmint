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
- MinIO Console: `http://localhost:9001`

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
| `DB_USER` | Yes | `aiuser` | PostgreSQL username |
| `DB_PASSWORD` | Yes | `changeme` | PostgreSQL password |
| `DB_NAME` | Yes | `hiai_docs` | Database name |
| `DB_HOST` | Yes | `localhost` | PostgreSQL host |
| `DB_PORT` | Yes | `5433` | PostgreSQL port |
| `BETTER_AUTH_SECRET` | **Yes** | — | Random 32+ char string |
| `BETTER_AUTH_URL` | Yes | `http://localhost:50700` | Public API URL |
| `MINIO_ACCESS_KEY` | Yes | `minioadmin` | MinIO access key |
| `MINIO_SECRET_KEY` | Yes | `minioadmin` | MinIO secret key |
| `MINIO_BUCKET` | Yes | `hiai-docs` | MinIO bucket name |
| `EMBEDDING_PROVIDER` | No | `ollama` | `ollama`, `openrouter`, or `voyage` |
| `EMBEDDING_MODEL` | No | `nomic-embed-text` | Model name |
| `OPENROUTER_API_KEY` | If fallback | — | OpenRouter API key |
| `API_PORT` | No | `50700` | Backend port |
| `WEB_PORT` | No | `50701` | Frontend port |
| `NODE_ENV` | No | `development` | `development` or `production` |
| `LOG_LEVEL` | No | `info` | `trace`/`debug`/`info`/`warn`/`error`/`fatal` |

## Production Considerations

### TLS

Use Caddy (included) or a reverse proxy. The default Caddyfile routes:
- `/api/*` → backend
- `/*` → frontend

For custom domains, update `Caddyfile` with your domain.

### Backups

```bash
# Database
docker compose exec postgres pg_dump -U aiuser hiai_docs > backup.sql

# Restore
cat backup.sql | docker compose exec -T postgres psql -U aiuser -d hiai_docs

# MinIO attachments
docker compose exec minio mc mirror /data ./backup-minio/
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
| postgres | 5433 | PostgreSQL 18 + pgvector |
| redis | 6380 | Cache/queue |
| ollama | 11434 | Embedding provider |
| minio | 9000/9001 | S3-compatible file storage |
| api | 50700 | Elysia REST API |
| web | 50701 | SvelteKit frontend |
| caddy | 80/443 | Reverse proxy |
