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
cd backend && bun run benchmark:search -- --base-url=http://127.0.0.1:50700
```

The benchmark reads credentials from environment/stdin/file and never accepts
an API key as a command-line argument. Record the exact counts, latency
percentiles, expansion coverage, graph contribution, invalid-vector count, and
tenant-leakage result in the release report.

## Known blockers to report, not hide

- The local PostgreSQL image may lack the `diskann` access method required by
  migration 0008. Fresh-chain migration verification remains blocked until the
  configured image exposes that access method or the migration is made
  conditional.
- The existing provider-mock suite may retain seven pre-existing failures when
  no live embedding endpoint is configured. Report those failures verbatim.
- No public release, tag, npm publish, Docker push, or GitHub push is authorized
  by this document; those are separate explicit release actions.

GraphRAG audit findings G1–G9 and N1 remain resolved. GraphRAG is automatic in
the reference profile and can be disabled only with `GRAPH_SEARCH_ENABLED=false`
as an operator kill switch.

---

*Status: Release Candidate — adaptive multilingual GraphRAG search*
