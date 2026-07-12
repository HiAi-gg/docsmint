# Release Checklist - hiai-docs

> Use this checklist for every release. Tick items as they are completed.

## Current v0.2.7 release candidate evidence (2026-07-11)

This is the verified local candidate. No tag, push, npm publish, Docker push,
or GitHub Release has been performed. Browser acceptance is intentionally
left to the operator on the running local build.

| Check | Evidence |
|-------|----------|
| Backend tests | **656 passed / 0 failed** (1 intentional skip; 657 tests across 75 files) |
| Frontend tests | **68 passed / 0 failed** |
| Lint, typecheck, build, SDK build | Passed |
| Compose config | Passed with the documented quickstart profile |
| Docker images | API, web, PostgreSQL/migration, and Caddy built locally |
| API image smoke | In-container `/api/health` returned HTTP 200 and `status: ok` |
| Fresh database | Full Drizzle journal `0000–0030` applied; AGE labels, graph indexes, vector indexes, RLS, and BullMQ pipeline state verified |
| Upgraded database | v0.2.6 fixture upgraded to current schema; legacy document and 1024-dim embedding preserved |
| Live GraphRAG benchmark | **Passed**: Recall@10 1.0, MRR@10 1.0, cross-language 4/4, leakage 0, invalid vectors 0, explanation failures 0 |
| Live GraphRAG latency | Fast p95 411ms; expanded p95 2485ms in the passing serialized run; provider latency remains environment-dependent |
| Embeddings | 8/8 fixture documents ready via `openai/text-embedding-3-small`, dimension 1024 |
| AGE graph | 52 nodes / 92 edges populated by real extraction |
| Browser smoke | **Operator gate** — verify manually at `http://localhost:57001` |

The candidate is release-ready only after the P0 package/CI gates below pass in
GitHub Actions and the operator confirms the browser flow.

## Pre-Release

- [ ] **Bump version** — Update version in all 9 files:
  - `package.json`
  - `backend/package.json`
  - `frontend/package.json`
  - `packages/db/package.json`
  - `packages/sdk/package.json`
  - `packages/cli/package.json`
  - `packages/mcp-server/package.json`
  - `package.public.json`
  - `backend/src/index.ts` (swagger version)
- [ ] **Regenerate secrets** — Generate fresh values for `BETTER_AUTH_SECRET`, `CSRF_SECRET`, `WEBHOOK_SECRET`, `HIAI_DOCS_API_KEY`:
      ```bash
      openssl rand -hex 32   # repeat for each secret
      ```
- [ ] **Update `.env.example`** if any new env vars were added
- [ ] **Verify search contract** — exact/title, multilingual FTS, fuzzy, vector, one-pass adaptive expansion, automatic GraphRAG, and RRF are documented; no public instructions require `?graph=true`
- [ ] **Verify embedding lifecycle** — pending/processing/ready/failed/stale states are documented; zero vectors are invalid; failed generations preserve the previous active generation
- [ ] **Verify public contracts** — `@hiai-gg/hiai-docs/frontend` exports only SSR-safe contracts and helpers; the module-level tab registry is available only from `frontend/legacy/doc-tab-registry`; `MIGRATION_DATABASE_URL` is explicit and runtime uses `hiai_app`
- [ ] **Verify migration job** — `docker compose run --rm migrate` applies the upstream journal before the API starts; `DATABASE_URL` is never used for DDL
- [ ] **Verify PostgreSQL bootstrap** — `postgres/init.sql` contains infrastructure setup only; application schema and graph/labels/indexes are created by Drizzle migrations
- [ ] **Build SDK** — `cd packages/sdk && bun run build` (ensures `dist/` is current before publishing)
- [ ] **Run full typecheck** — `bun run typecheck` (0 errors)
- [ ] **Run full test suite** — `bun run test` (backend 656/0 with 1 intentional skip and frontend 68/0 in the current candidate)
- [ ] **Run lint** — `bun run lint` (0 errors)
- [ ] **Run clean npm consumer smoke** — pack `package.public.json`, install in an empty npm project, import the SDK, run `hiai-docs --help`, and start `hiai-docs-mcp` without missing runtime dependencies
- [ ] **Run secret scans** — no real OpenRouter token values or real `OPENROUTER_API_KEY` outside ignored local `.env`; no unfinished markers in release files
- [ ] **Run migration/reindex dry-run** — `bun run db:migrate` then `cd backend && bun run src/scripts/reindex-embeddings.ts --dry-run --batch=100`
- [ ] **Run relevance benchmark** — `cd backend && bun run benchmark:search -- --base-url=http://127.0.0.1:50700 --owner-credentials-file=/run/secrets/hiai-docs-benchmark-owners.json`; operator credential comes from `HIAI_DOCS_API_KEY`/`BENCHMARK_API_KEY` via environment/stdin/file, owner credentials come from the protected JSON map, and no credential is ever passed in argv
- [ ] **Verify benchmark gates** — Recall@10 ≥ 0.90, MRR@10 ≥ 0.80, fast p95 ≤ 500 ms, expanded p95 ≤ 2.5 s, zero active invalid vectors, and zero tenant leakage
- [ ] **Verify fresh and upgraded databases** — apply migrations 0000–0030, reindex fixtures, and record both DiskANN/HNSW paths plus upgrade invariants
- [ ] **Verify pipeline migration** — confirm legacy list entries become one deterministic prepare job per active document revision
- [ ] **Verify restart recovery** — terminate workers during prepare/embed/graph/finalize, reconcile from PostgreSQL, and confirm no lost jobs, duplicate active generations, or cross-owner recovery
- [ ] **Verify rollback safety** — pause BullMQ producers/workers, preserve pipeline tables, and re-enqueue only nonterminal documents into the legacy list; never delete generation records

## Build

- [ ] **Build Docker images** — `docker compose build` (API, migration target, web, and Caddy; local candidate export passed)
- [ ] **Verify Docker health** — `docker compose up -d && docker exec hiai-docs-api wget -qO- http://127.0.0.1:50700/api/health`
- [ ] **Operator browser acceptance** — manually verify `http://localhost:57001` (login, import, search, share, images, align/list, and export); this is intentionally not automated in CI
- [ ] **Run DB migrations** — `bun run db:migrate` (loads the root `.env` and applies the canonical Drizzle migration journal)

## Release

- [ ] **Commit and tag** — `git add -A && git commit -m "Release v<version>" && git tag -a v<version> -m "v<version>"`
- [ ] **Push** — `git push origin main --tags`
- [ ] **Verify CI** — Confirm CI pipeline passes on GitHub Actions
- [ ] **Verify Docker Hub** — Images pushed as `vgalibov/hiai-docs:api-v<version>` and `vgalibov/hiai-docs:web-v<version>`
- [ ] **Verify npm** — `npm view @hiai-gg/hiai-docs@<version>` shows the new version
- [ ] **Create GitHub release** — Use the tag, include changelog summary

> Do not tag, publish, push, or create a GitHub release from the Task 10
> verification contour. Those actions require a separate explicit release
> authorization after this checklist and evidence are reviewed.

## Post-Release

- [ ] **Deploy to staging** — Pull latest on staging host
- [ ] **Smoke test** — Sign up, create doc, search, share, verify
- [ ] **Deploy to production** — Pull latest on production host
