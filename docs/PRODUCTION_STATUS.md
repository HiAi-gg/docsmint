# Production Status Report

> **Status:** BLOCKED — adaptive multilingual GraphRAG search is not release-ready
> **Last verified:** 2026-07-11

## Verification results

| Check | Status |
|-------|--------|
| Typecheck | PASS |
| Lint | PASS |
| Build | PASS |
| SDK build | PASS |
| Compose config | PASS |
| Backend tests | PASS — 576 passed / 0 failed |
| Frontend tests | 55 passed / 0 failed |
| Health checks | PASS for the disposable core Compose stack — API and web containers healthy; Caddy profile not started |
| Browser smoke | BLOCKED — agent-browser daemon could not start in this sandbox |
| Search benchmark | BLOCKED — live benchmark and release gates not run |
| Docker image export | PASS — API, web, and Caddy images exported locally |
| Fresh database | PASS through migrations 0000–0025 on custom image; optional DiskANN and HNSW both verified; 0026 chunk-hash migration added afterward |
| Upgraded database | NOT RUN |

Passing static checks do not constitute release approval. The current release
remains blocked by the missing live benchmark, upgraded-database evidence, and
browser smoke.

### Current Task 10 verification status

The assembled-worktree verification on 2026-07-11 is not a release approval:

| Check | Current evidence |
|-------|------------------|
| Backend tests | 576 passed / 0 failed after isolating the process-global integration mock from provider unit tests |
| Frontend tests | 55 passed / 0 failed |
| Typecheck, lint, build, SDK build | PASS in the assembled worktree |
| Compose config | PASS (`docker compose --env-file .env.example config --quiet`) |
| Health checks | Core disposable Compose stack is healthy; in-container API health returned `status: ok`/HTTP 200 and web served `/login` on port 57001 |
| Search benchmark | Not run against a live API; Recall/MRR/latency/leakage gates are therefore unverified |
| Browser smoke | Blocked: `agent-browser` daemon exits during startup even with its socket redirected to `/tmp` |
| Docker images | API, web, and Caddy images built and imported successfully; frontend image serves `/` on port 50701 after the `PORT` default fix |
| Fresh database | Custom image applied migrations 0000–0025 with AGE/GraphRAG labels and DiskANN; migration 0026 restores nullable `chunk_hash` and still needs a journaled rerun |
| Upgraded database | Not run |
| Public release actions | Not performed: no publish, tag, GitHub release, Docker push, npm publish, or Git push |

## Architecture

The search contour contains exact/title, multilingual lexical, fuzzy, vector,
adaptive expansion, and automatic GraphRAG channels. Reciprocal rank fusion
(RRF) combines candidates with exact-title and channel-agreement boosts. Graph
contribution is capped and graph failures degrade to direct results.

Embedding generations transition through `pending`, `processing`, `ready`,
`failed`, and `stale`. Only complete finite, non-zero 1024-dimensional
generations are queryable. A failed replacement never removes the last active
generation, and GraphRAG extraction runs only after activation.

Security includes rate limiting, Zod validation, owner/share scoping, CSRF
protection, CORS, security headers, tenant-scoped expansion cache keys, and
safe public result explanations without prompts, credentials, or tenant data.

## Deployment

```bash
git clone https://github.com/hiai-gg/hiai-docs.git && cd hiai-docs
cp .env.example .env
docker compose pull && docker compose up -d
bun run db:migrate
```

### Ports

| Port | Service |
|------|---------|
| 50700 | API |
| 50701 | Frontend |
| 5437 | PostgreSQL |
| 6384 | Redis |
| 9020 | SeaweedFS S3 |
| 80/443 | Caddy |

## Testing and release gates

Run `bun run test`, `bun run lint`, `bun run typecheck`, `bun run --filter '*'
build`, and `docker compose --env-file .env.example config --quiet` from the
repository root. Run the
generation-aware reindex dry-run and then:

```bash
cd backend && bun run benchmark:search -- --base-url=http://127.0.0.1:50700 --owner-credentials-file=/run/secrets/hiai-docs-benchmark-owners.json
```

The operator credential for admin metrics must be supplied through
`HIAI_DOCS_API_KEY` or `BENCHMARK_API_KEY` (environment, stdin, or a protected
file). Search probes use a separate owner-credential JSON map, for example:

```json
{
  "owner-a": { "authorization": "Bearer replace-with-owner-a-token" },
  "owner-b": { "cookie": "better-auth.session_token=replace-with-owner-b-session" }
}
```

Keep the map at `/run/secrets/hiai-docs-benchmark-owners.json` or another
protected path outside the repository. Do not pass an operator API key or
owner credential in argv (`--api-key=...` is rejected), because argv is
visible to process inspection and shell history. Record the exact counts,
latency percentiles, expansion coverage, graph contribution, invalid-vector
count, and tenant-leakage result in the release report.

## Known blockers to report, not hide

- The local PostgreSQL image may lack the `diskann` access method required by
  migration 0008. Fresh-chain migration verification remains blocked until the
  configured image exposes that access method or the migration is made
  conditional.
- No public release, tag, npm publish, Docker push, or GitHub push is authorized
  by this document; those are separate explicit release actions.

For GraphRAG extraction credentials, exact OpenRouter hostnames may use
`OPENROUTER_API_KEY` when no provider-specific key is set. Local no-auth
endpoints may leave `GRAPH_EXTRACT_API_KEY` (and its fallback counterpart)
blank; custom providers may set a dedicated key for their endpoint. The shared
OpenRouter key is never inherited by non-OpenRouter endpoints.

GraphRAG audit findings G1–G9 and N1 remain resolved. GraphRAG is automatic in
the reference profile and can be disabled only with `GRAPH_SEARCH_ENABLED=false`
as an operator kill switch.

---

*Status: BLOCKED — Release Candidate pending required verification gates*
