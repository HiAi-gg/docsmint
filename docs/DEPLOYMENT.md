# Deployment

This guide covers supported self-hosted installation and production operation.
For system internals, HTTP contracts, or maintainer release steps, see
[Architecture](ARCHITECTURE.md), [API](API.md), and [Releasing](RELEASING.md).

## Supported quick start

Requirements:

- Docker Engine with Docker Compose v2;
- Git;
- an OpenRouter API key, or an accessible Ollama installation.

```bash
git clone https://github.com/HiAi-gg/hiai-docs.git
cd hiai-docs
cp .env.example .env
# Add OPENROUTER_API_KEY, or set AI_PROVIDER=ollama and OLLAMA_PORT.
bash scripts/quickstart.sh
```

The root `.env` is user-owned and ignored by Git. The user supplies only the AI
provider input. `scripts/quickstart.sh` replaces infrastructure placeholders
with random local secrets, builds the supported PostgreSQL image, runs all
migrations, and starts the stack. It does not print generated secrets.

Do not copy secrets into source files, command arguments, logs, screenshots, or
documentation. Keep `.env` or the equivalent production secret store across
subsequent starts.

### AI provider

OpenRouter is the reference profile:

```dotenv
OPENROUTER_API_KEY=sk-or-...
```

For Ollama running on the Docker host:

```dotenv
AI_PROVIDER=ollama
OLLAMA_PORT=11434
```

The quick-start profile configures the corresponding embedding and extraction
endpoints. Advanced deployments may override the `EMBEDDING_*`,
`EMBEDDING_FALLBACK_*`, `GRAPH_EXTRACT_*`, and
`GRAPH_EXTRACT_FALLBACK_*` variables documented in `.env.example`.

All embedding providers must return finite, non-zero vectors with exactly 1024
dimensions. OpenRouter requests that dimension explicitly. For Ollama, install
a compatible embedding model and an OpenAI-compatible chat model. Set
`PROVIDER_LIMITER_MODE=local` and `PROVIDER_REQUESTS_PER_MINUTE=0` for an
unlimited local provider. If GPU memory is exhausted, reduce the queue
concurrency values in `.env.example` instead of disabling the pipeline.

## Endpoints and ports

| Service | Host port | Purpose |
|---|---:|---|
| Web | `50701` | Product UI |
| API | `50700` | REST API and `/api/docs` |
| PostgreSQL | `5437` | Application database |
| Redis | `6384` | Cache and BullMQ transport |
| SeaweedFS S3 | `50702` | Attachment storage |
| SeaweedFS console | `50703` | Storage administration |
| Caddy | `80`, `443` | Optional reverse proxy and TLS |

Docker host-port overrides change only published bindings. Containers continue
to use `api:50700`, `postgres:5432`, `redis:6379`, and the internal SeaweedFS
ports on the Compose network.

After installation:

```bash
curl -fsS http://localhost:50700/api/health
docker compose ps
```

Open the UI at <http://localhost:50701> and API documentation at
<http://localhost:50700/api/docs>.

## PostgreSQL requirement

hiai-docs does **not** support a plain PostgreSQL image for the complete search
stack. Use the repository image built from `postgres/Dockerfile`. It combines:

- PostgreSQL 18;
- pgvector;
- pgvectorscale;
- Apache AGE;
- `pg_trgm`.

The image bootstrap installs extensions and creates the restricted `hiai_app`
runtime role. Drizzle migrations are the sole owner of relational schema,
indexes, grants, and the `docs_graph` AGE graph. PostgreSQL, vector search, and
GraphRAG therefore run in one database; no separate graph database is needed.

On a clean installation, Compose builds this image and the one-shot migration
service applies the full migration journal before the API starts. Replacing it
with `postgres:18` will fail when migrations reach vector or AGE objects.

## Production deployment

Before exposing the service:

1. Put `.env` values in a protected secret store or restrict the file to the
   service account.
2. Set public `BETTER_AUTH_URL`, storage endpoint values, and exact
   `CORS_ORIGINS`.
3. Generate a strong `HIAI_DOCS_API_KEY` for operator-only admin routes.
4. Use durable volumes for PostgreSQL and SeaweedFS.
5. Configure TLS, backups, monitoring, and provider budgets.
6. Run `docker compose config --quiet` before starting.

`HIAI_DOCS_API_KEY` is an operator credential for `/api/admin/*` and protected
metrics. Do not distribute it to CLI, MCP, SDK, or Docsmint users. Create global
or category-scoped integration keys from an authenticated product session; see
[API authentication](API.md#authentication-and-keys).

### Reverse proxy, TLS, and CORS

The optional Caddy profile routes `/api/*` to the API and all other paths to the
web service:

```bash
docker compose --profile caddy up -d
```

Set your domain in `Caddyfile`, make `BETTER_AUTH_URL` match the public API
origin, and list each permitted browser origin exactly in `CORS_ORIGINS`:

```dotenv
BETTER_AUTH_URL=https://docs.example.com
CORS_ORIGINS=https://docs.example.com,https://app.example.com
```

Server-to-server SDK, CLI, MCP, and Docsmint calls are not governed by browser
CORS, but must use the public API origin and a suitable Bearer key. Browser-side
Docsmint integrations require their precise origin in `CORS_ORIGINS`.

If a proxy terminates TLS, preserve the original host and protocol headers.
Attachment upload and public/share rendering also require
`STORAGE_PUBLIC_ENDPOINT` and `STORAGE_PUBLIC_PORT` to describe an address the
user's browser can reach; an internal container hostname is not sufficient.

## Upgrades and migrations

Read [CHANGELOG](../CHANGELOG.md) before upgrading and take a database and
attachment backup first. Then update the checkout and rebuild the images:

```bash
git pull --ff-only
docker compose build
docker compose run --rm migrate
docker compose up -d
```

The API runtime image intentionally does not own migration source. The Compose
`migrate` service applies the checked-in Drizzle journal with the database-owner
credential. Never edit an already released migration. Generate new migrations
for schema changes:

```bash
cd packages/db
bun run db:generate
bun run db:migrate
```

`bun run db:push` is for disposable development databases only. After an
upgrade, verify the migration container exited successfully, the API is healthy,
and existing documents remain accessible. Provider/model changes may require a
controlled reindex; use the admin operations described in [API](API.md), not
manual edits to embedding rows.

## Backup and restore

Back up PostgreSQL and attachment data together so database records and stored
objects describe the same point in time.

```bash
# Database backup
docker compose exec -T postgres \
  pg_dump -U aiuser -d hiai_docs --format=custom > hiai-docs.dump

# Database restore into an empty compatible database
docker compose exec -T postgres \
  pg_restore -U aiuser -d hiai_docs --clean --if-exists < hiai-docs.dump
```

Back up the SeaweedFS Docker volume with your infrastructure's volume-snapshot
mechanism. Test restoration periodically against the same hiai-docs PostgreSQL
image version. Stop application writes or use coordinated snapshots while
capturing both stores. Never commit backup files.

## Local development

The production quick start is preferred for evaluating the complete product.
For source development:

```bash
bun install
docker compose -f docker-compose.dev.yml up -d
cd packages/db && bun run db:migrate && cd ../..
```

Then run the backend and frontend in separate terminals:

```bash
cd backend && bun run dev
cd frontend && bun run dev
```

The same PostgreSQL extension requirement applies to development when vector or
GraphRAG migrations are enabled.

## Operations and troubleshooting

### Health checks

```bash
curl -fsS http://localhost:50700/api/health
docker compose exec postgres pg_isready -U aiuser -d hiai_docs
docker compose exec redis redis-cli ping
docker compose ps
```

### API does not start

- Inspect `docker compose logs migrate api`.
- Confirm the migration service completed successfully.
- Validate `DATABASE_URL`, generated passwords, and `BETTER_AUTH_URL`.
- If vector or AGE extension errors appear, rebuild and use the repository
  PostgreSQL image rather than a stock image.

### Login, mutations, or imports return 403

- Make the browser origin exactly match `CORS_ORIGINS`.
- Make the public protocol and host match `BETTER_AUTH_URL`.
- Preserve proxy forwarded-host and forwarded-proto headers.
- Confirm cookies are not being downgraded or stripped by the proxy.

### Attachments fail to upload or render

- Check API and SeaweedFS health and credentials.
- Ensure `STORAGE_PUBLIC_ENDPOINT` is reachable from the browser.
- Confirm reverse-proxy upload limits exceed `ATTACHMENT_MAX_SIZE_MB`.
- Do not expose an internal Docker hostname in a presigned URL.

### Search returns no semantic or graph results

- Inspect the document pipeline endpoint and worker logs.
- Verify Redis is reachable and BullMQ workers are running.
- Confirm provider URLs, models, credentials, and 1024-dimensional output.
- Confirm AGE and vector extensions exist in the supported PostgreSQL image.
- Provider or graph failures degrade search channels; they do not make lexical
  search unavailable.

### Queues are slow

Embedding and GraphRAG work is asynchronous. A newly imported document may be
visible before its pipeline is ready. Check `GET /api/documents/:id/pipeline`
before depending on semantic or graph retrieval. Tune only one queue concurrency
setting at a time while observing provider latency, error rate, and memory use.

For API routes and credentials, use [API](API.md). For service and pipeline
design, use [Architecture](ARCHITECTURE.md). For public release verification,
use [Releasing](RELEASING.md).
