# Release Checklist - hiai-docs

> Use this checklist for every release. Tick items as they are completed.

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
- [ ] **Run full test suite** — `bun test` (all passing)
- [ ] **Run lint** — `bun run lint` (0 errors)
- [ ] **Run secret scans** — no real OpenRouter token values or real `OPENROUTER_API_KEY` outside ignored local `.env`; no unfinished markers in release files
- [ ] **Run migration/reindex dry-run** — `bun run db:migrate` then `cd backend && bun run src/scripts/reindex-embeddings.ts --dry-run --batch=100`
- [ ] **Run relevance benchmark** — `cd backend && bun run benchmark:search -- --base-url=http://127.0.0.1:50700`; credential must come from environment/stdin/file, never argv
- [ ] **Verify benchmark gates** — Recall@10 ≥ 0.90, MRR@10 ≥ 0.80, fast p95 ≤ 500 ms, expanded p95 ≤ 2.5 s, zero active invalid vectors, and zero tenant leakage
- [ ] **Verify fresh and upgraded databases** — apply migrations 0000–0025, reindex fixtures, and record the DiskANN access-method blocker if the configured image cannot provide it

## Build

- [ ] **Build Docker images** — `docker compose build` (api, migration target, and web; build Caddy separately when releasing the proxy image)
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
