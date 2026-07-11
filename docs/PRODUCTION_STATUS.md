# Production Status Report

> **Status:** Release Candidate — adaptive multilingual GraphRAG search
> **Last verified:** 2026-07-11

## Verification results

| Check | Status |
|-------|--------|
| Typecheck | Pending final assembled-worktree run |
| Tests | Focused task suites pass; release run must record the complete matrix |
| Build | Pending final assembled-worktree run |
| Health checks | Pending stack and browser smoke |
| Search benchmark | Must meet Recall@10 >= 0.90, MRR@10 >= 0.80, fast p95 <= 500 ms, expanded p95 <= 2.5 s, zero active invalid vectors, and zero tenant leakage |

### Current Task 10 verification status

The assembled-worktree verification on 2026-07-11 is not a release approval:

| Check | Current evidence |
|-------|------------------|
| Backend tests | 569 passed / 7 known embedding-provider mock failures; failures are recorded and are not documentation regressions |
| Frontend tests | 55 passed / 0 failed |
| Docker images | Export incomplete; backend and web compilation reached the final runtime `chown` layers, but image export was interrupted |
| Fresh database | Blocked by migration `0008_streaming_diskann_index.sql`; the configured local PostgreSQL image does not expose the required `diskann` access method |
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
build`, and `docker compose config --quiet` from the repository root. Run the
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
- The existing provider-mock suite may retain seven pre-existing failures when
  no live embedding endpoint is configured. Report those failures verbatim.
- No public release, tag, npm publish, Docker push, or GitHub push is authorized
  by this document; those are separate explicit release actions.

For GraphRAG extraction credentials, an exact OpenRouter base URL may inherit
`OPENROUTER_API_KEY`. Custom or non-OpenRouter extraction endpoints require a
dedicated `GRAPH_EXTRACT_API_KEY` (and a dedicated fallback key when the
fallback endpoint is custom); the shared OpenRouter key is never forwarded to
those endpoints.

GraphRAG audit findings G1–G9 and N1 remain resolved. GraphRAG is automatic in
the reference profile and can be disabled only with `GRAPH_SEARCH_ENABLED=false`
as an operator kill switch.

---

*Status: Release Candidate — adaptive multilingual GraphRAG search*
