# Release Checklist — hiai-docs

> Use this checklist for every release. Tick items as they are completed.

## Pre-Release

- [ ] **Bump version** — Update version in `package.json`, `backend/package.json`, `frontend/package.json`, `packages/db/package.json`
- [ ] **Regenerate secrets** — Generate fresh values for `BETTER_AUTH_SECRET`, `CSRF_SECRET`, `WEBHOOK_SECRET`, `HIAI_DOCS_API_KEY`:
      ```bash
      openssl rand -hex 32   # repeat for each secret
      ```
- [ ] **Update `.env.example`** if any new env vars were added
- [ ] **Run full typecheck** — `bun run typecheck` (0 errors)
- [ ] **Run full test suite** — `bun test` (all passing)
- [ ] **Run lint** — `bun run lint` in backend (0 errors)

## Build

- [ ] **Build Docker images** — `docker compose build` (both `api` and `web`)
- [ ] **Verify Docker health** — `docker compose up -d && curl -fsS http://localhost:50700/api/health`
- [ ] **Run DB migrations** — `docker compose exec api bun run db:migrate`

## Release

- [ ] **Commit and tag** — `git tag -a v<version> -m "v<version>"`
- [ ] **Push** — `git push origin dev --tags`
- [ ] **Create GitHub release** — Use the tag, include changelog summary
- [ ] **Verify CI** — Confirm CI pipeline passes on GitHub Actions

## Post-Release

- [ ] **Deploy to staging** — Pull latest on staging host
- [ ] **Smoke test** — Sign up, create doc, search, share, verify
- [ ] **Deploy to production** — Pull latest on production host
