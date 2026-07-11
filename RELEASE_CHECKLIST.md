# Release Checklist - hiai-docs

> Use this checklist for every release. Tick items as they are completed.

## Current Task 10 Verification Status — v0.2.7 candidate (2026-07-11)

This section records the current evidence before any public release action:

| Check | Status |
|-------|--------|
| Backend tests | 576 passed / 0 failed |
| Frontend tests | 55 passed / 0 failed |
| Lint, typecheck, build, SDK build | Passed in the assembled worktree |
| Compose config | Passed with `.env.example` |
| Docker image export | Passed; API, web, and Caddy images exported locally |
| API image smoke | Passed in-container: `/api/health` returned HTTP 200 with `status: ok` |
| Fresh database migration | PASS for migrations 0000–0025 on custom image; AGE/GraphRAG labels and DiskANN verified; 0026 `chunk_hash` migration added and journaled rerun pending |
| Upgraded database migration | Not run |
| Live relevance benchmark | Not run; Recall/MRR/latency/tenant-leakage gates remain unverified |
| Full Compose health | Not run |
| Browser smoke | Blocked; `agent-browser` daemon could not start in this sandbox |
| Public release actions | Not performed: no publish, tag, GitHub release, Docker push, npm publish, or Git push |

These remaining blockers must stay visible in the release evidence; they are
not release approvals or reasons to mark the corresponding checklist items
done.
This file describes a v0.2.7 release candidate, not a completed public release.

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
- [ ] **Run full test suite** — `bun run test` (backend 576/0 and frontend 55/0 in the current candidate)
- [ ] **Run lint** — `bun run lint` (0 errors)
- [ ] **Run secret scans** — no real OpenRouter token values or real `OPENROUTER_API_KEY` outside ignored local `.env`; no unfinished markers in release files
- [ ] **Run migration/reindex dry-run** — `bun run db:migrate` then `cd backend && bun run src/scripts/reindex-embeddings.ts --dry-run --batch=100`
- [ ] **Run relevance benchmark** — `cd backend && bun run benchmark:search -- --base-url=http://127.0.0.1:50700 --owner-credentials-file=/run/secrets/hiai-docs-benchmark-owners.json`; operator credential comes from `HIAI_DOCS_API_KEY`/`BENCHMARK_API_KEY` via environment/stdin/file, owner credentials come from the protected JSON map, and no credential is ever passed in argv
- [ ] **Verify benchmark gates** — Recall@10 ≥ 0.90, MRR@10 ≥ 0.80, fast p95 ≤ 500 ms, expanded p95 ≤ 2.5 s, zero active invalid vectors, and zero tenant leakage
- [ ] **Verify fresh and upgraded databases** — apply migrations 0000–0026, reindex fixtures, and record both DiskANN/HNSW paths plus upgrade invariants

## Build

- [ ] **Build Docker images** — `docker compose build` (API, migration target, web, and Caddy; local candidate export passed)
- [ ] **Verify Docker health** — `docker compose up -d && docker exec hiai-docs-api wget -qO- http://127.0.0.1:50700/api/health`
- [ ] **Run agent-browser smoke** — verify `http://localhost:50701/search`, a cross-language query, explanations, and no console errors
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
