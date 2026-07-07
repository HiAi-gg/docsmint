# Production Readiness Audit — hiai-docs

> **Note:** This audit was performed at HEAD `14b3fd9` (post-v0.1.0). Most 🔴 and 🟠 items were addressed in **v0.1.1** (2026-07-01). See [CHANGELOG.md](../CHANGELOG.md#0111---2026-07-01) for fixes. Items marked ✅ below were verified resolved by the v0.1.1 doc audit (2026-07-02).
> **Audit date:** HEAD `14b3fd9` (branch `main`), after tag `v0.1.0` (`ef831bf`).
> **Method:** static repository analysis + `bun run typecheck` / `bun run lint`. Tests were intentionally not run: a live **dev** stack with DB on `:5437` was active, and `bun test` writes to the DB (CI uses a separate `hiai_docs_test` database).
> **Nothing in the repository was modified** — analysis only.

## Verdict (original)

**Not ready for production "out of the box."** The codebase is high quality (typecheck clean, versions synchronized, multi-stage Docker builds with non-root user), but the **deployment/config layer contains blocking defects**. The document `docs/PRODUCTION_STATUS.md` claims `✅ READY FOR DEPLOYMENT`, but it is outdated, and the recommended path `cp .env.example .env && docker compose up -d` is insecure.

Below — in descending severity, with `file:line` references.

---

## 🔴 BLOCKING (cannot ship to production as-is)

### 1. Production compose starts the application in development mode
`docker-compose.yml:147` — `NODE_ENV: development` in the "production" compose file.

**✅ Fixed in v0.1.1** — `docker-compose.yml:149` now `${NODE_ENV:-production}`.

Consequences (original):
- The only production guard in the config schema (`backend/src/lib/config-schema.ts:25-30` checks `BETTER_AUTH_SECRET != default` **only** when `NODE_ENV=production`) is bypassed. In `development`, the app silently starts with a default/weak secret.
- Dev code paths, verbose logging, and disabled production optimizations.

Meanwhile `Dockerfile.backend:52` correctly sets `NODE_ENV=production` — compose overrode it.

### 2. Production compose does NOT pass `CSRF_SECRET` and `WEBHOOK_SECRET`
In the `api` service `environment` block (`docker-compose.yml:106-148`), these variables are absent. In `backend/src/lib/config-schema.ts:32,34` they have **no** production guard (unlike `BETTER_AUTH_SECRET`) — they silently default to `"change-me-to-random-32-chars"` **in any environment, including production**. A production deployment signs CSRF tokens and webhooks with a publicly known default.

Meanwhile `docs/DEPLOYMENT.md:59-60` marks them as `Required`. CI does not catch this — `.github/workflows/ci.yml` only validates `docker compose config --quiet` (syntax), not actual stack startup.

**✅ Fixed in v0.1.1** — `docker-compose.yml:127-128` now `${CSRF_SECRET:-change-me-to-random-32-chars}` / `${WEBHOOK_SECRET:-change-me-to-random-32-chars}`. Schema has production `refine()` guards.

### 3. Real secrets in the public `.env.example`
`.env.example` is tracked in git. It contained:
- `BETTER_AUTH_SECRET` = 64-character hex (`.env.example:18`) — not a placeholder, it's exactly what `openssl rand -hex 32` produces;
- `HIAI_DOCS_API_KEY` = 64-character hex (`.env.example:77`);
- `OWNER_ID` = actual UUID (`.env.example:80`).

For contrast, `STORAGE_SECRET_KEY=changeme` (8 characters) is a normal placeholder. The file header says "edit the values marked with CHANGE", but no value was marked `CHANGE`. This violates the project's own `RELEASE_CHECKLIST.md:8-11` ("Regenerate secrets"). The repo is public (MIT). If these values match the production `.env`, it is a leak; even if not, publishing generated secrets in the template encourages operators to leave them as-is.

**✅ Fixed in v0.1.1** — all secrets replaced with `change-me` placeholders and `# CHANGE-ME` comment markers.

### 4. Production Caddy fails to start due to `rate_limit`
`Caddyfile:30` uses the `rate_limit` directive, which does **not** exist in the standard `caddy:2-alpine` image (it is a third-party module `caddy-ratelimit`, requiring a custom xcaddy build). The compose file uses the standard image (`docker-compose.yml:187`) without a custom build — Caddy crashes with `unknown directive: rate_limit`.

CI does not catch this: Caddy does not start under the `caddy` profile, and the Caddyfile is not validated. Notably, `.bob/plans/open-source-release-v1.md:35` itself noted "HIGH — No rate_limit" — the "fix" inserted the directive into an image that does not support it.

**✅ Fixed in v0.1.1** — `Dockerfile.caddy` builds via xcaddy with `caddy-ratelimit` module; compose uses the custom image.

### 5. Build not reproducible: `bun.lock` in `.gitignore`, dependencies all `"latest"`
`.gitignore:3` — `bun.lock` (confirmed: `git ls-files bun.lock` is empty). Meanwhile `"latest"` is used on **~80 dependencies**: `backend/package.json` — 22, `frontend/package.json` — 49, `packages/db/package.json` — 6, root `package.json` — 3 (elysia, better-auth, drizzle-orm, zod, vite, svelte, etc.). Any `bun install` resolves to the actual "latest" on the day of installation → the build can break at any time without code changes. Critical for reproducibility and supply-chain security in production.

**✅ Fixed in v0.1.1** — `bun.lock` tracked; ~80 deps pinned to ranges per CHANGELOG.

---

## 🟠 HIGH priority

### 6. Caddy auto-TLS broken by non-standard port mapping
`docker-compose.yml:192-193` — `50708:80`, `50709:443`, but the production Caddyfile block (`Caddyfile:22` — `docs.{$DOMAIN}`) expects automatic TLS issuance via HTTP-01/TLS-ALPN, which requires standard ports 80/443 externally. With the 50xxx mapping, automatic certificates will not be issued.

**✅ Fixed in v0.1.1** — compose now maps `80:80` and `443:443`.

### 7. Production compose hardcodes config knobs instead of `${VAR}`
`docker-compose.yml:138-146` explicitly sets: `GRAPH_EXTRACT_MIN_CONFIDENCE: 0.5`, `GRAPH_EXPANSION_BOOST: 0.3`, `HYBRID_TEXT_WEIGHT: 0.4`, `HYBRID_SEMANTIC_WEIGHT: 0.6`, `CHUNK_TARGET_TOKENS: 500`, `CHUNK_OVERLAP_TOKENS: 50`, `FOLDER/CATEGORY/TAG_REEMBED_BATCH_SIZE`. Changing these values in `.env` **has no effect** when running through `docker-compose.yml`. The `.env.example:4-5` itself warns "do NOT rely on the docker-compose.yml defaults for prod" — the problem is known but not fixed.

**✅ Fixed in v0.1.1** — all `HYBRID_*`, `CHUNK_*`, `GRAPH_*`, `REEMBED_*` values now `${VAR:-default}`.

### 8. `STORAGE_PUBLIC_ENDPOINT: localhost` breaks presigned uploads behind a domain
`docker-compose.yml:114-115` — the public SeaweedFS endpoint is hardcoded to `localhost`. Presigned URLs for file uploads from the browser will point to `localhost`, so behind a real domain (via Caddy), file attachments will fail.

**⚠️ Partially addressed** — now `${STORAGE_PUBLIC_ENDPOINT:-localhost}` (parameterized but default still localhost). Operator must set this for production domains.

### 9. `chrislusf/seaweedfs:3.85` not pinned
In both compose files (`docker-compose.yml:53`, `docker-compose.dev.yml:47`) — non-reproducible and supply-chain risk.

**✅ Fixed in v0.1.1** — pinned to `chrislusf/seaweedfs:3.85.2025-06-26T16-23-29Z`.

### 10. Registry mismatch
CI pushes to `vgalibov/hiai-docs:api-<tag>` / `:web-<tag>` (`.github/workflows/ci.yml:322-329`), while `RELEASE_CHECKLIST.md:28` and `docs/PRODUCTION_STATUS.md` reference `hiai-gg/hiai-docs:api-v<version>`. An operator following the checklist will not find the images.

**⚠️ Known — documented** in CHANGELOG as intentional ("hiai-gg registry doesn't exist yet").

### 11. `main` ahead of tag `v0.1.0` by 4 commits
Tag `v0.1.0` exists (`ef831bf`), but HEAD = `14b3fd9`, with post-release fixes (`cf03e3e`, `8668c6c`, `9b4f52d` — tests/CI/`init.sql`). The release artifact lags behind HEAD.

**✅ Resolved** — v0.1.1 tag now at HEAD.

---

## 🟡 MEDIUM priority

### 12. Port discrepancies across the repo
Confuses operators; single source of truth is unclear:
- **DB:** `5433` (PRODUCTION_STATUS, DEPLOYMENT, health-check) vs `5437` (`.env.example:13`, dev-compose) vs default `5433` in prod-compose.
- **SeaweedFS:** `9020` (`.env.example:23`) vs `9000` (compose default, `scripts/health-check.sh:32`) vs console `9021`/`9001` (`docs/DEPLOYMENT.md` contradicts itself: line 18 — `9001`, line 115 — `9000/9021`).
- **Redis:** `6384` (compose) vs `6380` (`scripts/health-check.sh:14,30` — default, with comment "matches REDIS_URL in .env.example", which is incorrect) vs internal `6379`; `docs/DEPLOYMENT.md:62` incorrectly writes default `redis://redis:6384` (inside the network, port is 6379).
- **Caddy:** `80/443` (PRODUCTION_STATUS) vs `50708/50709` (compose).

**✅ Mostly resolved in v0.1.1** — health-check corrected; AGENTS.md and design-spec.md updated in this doc sweep.

### 13. `docs/PRODUCTION_STATUS.md` outdated
"Last verified: 2026-06-14", file last modified `2026-06-20`, but `v0.1.0` and 4 post-release commits are already in July. The claim "10 route files" (`:19`) is incorrect: `backend/src/api/routes/` has **14** files (added `admin`, `categories`, `graph`, `metrics`). "178/178 tests passing" (`:45`) for current HEAD was **not verified**.

**✅ Updated** — now shows 14 routes, 451 tests, v0.1.1 status.

### 14. CHANGELOG not updated for release
`CHANGELOG.md:9` — section `## [Unreleased]`, but its "Highlights" (unified PostgreSQL image, etc.) were already included in tag `v0.1.0`. The block was not renamed to `[0.1.0]` with a date.

**✅ Fixed** — CHANGELOG shows proper `[0.1.0]` and `[0.1.1]` headings.

### 15. CI checks different code than what is committed
`.github/workflows/ci.yml` uses `bun-version: latest`, `npm install -g npm@latest`, `moby/buildkit:latest`; plus **at runtime rewrites `package.json`** (filters `hiai-ui` from workspaces, pins `@hiai-gg/hiai-ui` to `^0.0.1`) — a workaround for the missing private package in CI. CI thus checks a dependency graph different from the committed one.

**⚠️ Still open** — CI workaround for missing private `hiai-ui` package. Not yet resolved.

### 16. Frontend Dockerfile copies entire `node_modules` into runtime
`frontend/Dockerfile:29-30` copies `node_modules` entirely (including devDeps) — larger image, more attack surface. Functionally works but is suboptimal for production.

**⚠️ Still open** — not yet optimized.

---

## 🟢 LOW priority / hygiene

### 17. `docker-compose.dev.yml` diverges from the unified image
There is a separate `age-postgres` service and `hiai_app` role (`docker-compose.dev.yml:103,138-158`), which is **not created** in `postgres/init.sql` or the Dockerfile (only `aiuser` exists). A fresh dev setup using `hiai_app` will fail authentication. This is dev-only but contradicts AGENTS.md / `postgres/init.sql`.

**⚠️ Still open** — `hiai_app` role handling may still have issues per init.sql.

### 18. Caddyfile, `:80` block
`Caddyfile:13` — catch-all with dev-CSP (`connect-src 'self' http://localhost:50700 ws://localhost:50700`). Not suitable as a default vhost for production.

**⚠️ Still open**

### 19. No E2E and no automated backups
Documented in `docs/PRODUCTION_STATUS.md:53-57` — a known gap, but worth keeping in mind for production.

**⚠️ Known gap** — tracked in todo.md.

---

## ✅ What is done well (for objectivity)

- TypeScript strict: `bun run typecheck` — **0 errors**, 3 warnings (frontend).
- Versions **synchronized across all 6 files** (`0.1.0`), including swagger in `backend/src/index.ts:83`. Tag `v0.1.0` exists.
- Multi-stage Dockerfiles with **non-root `app`**, `NODE_ENV=production` inside images, health checks.
- Zod config schema with production guard on `BETTER_AUTH_SECRET`; rich security stack (CSRF, rate-limit, Argon2id, RLS multi-tenant, CSP/HSTS, Zod validation on every route).
- PostgreSQL image well-pinned (PG 18.1, pgvector 0.8.3, pgvectorscale 0.9.0, AGE 1.7.0).
- **No technical debt from TODO/FIXME in core:** 46 matches for `TODO|FIXME|HACK|console.log` — **all** in `backend/src/scripts/benchmark-graph.ts` (benchmark, not production code).
- CI covers lint/typecheck/test/docker-build+scan/npm publish with provenance.

---

## Recommended action order (original)

1. **Security/config:** in `docker-compose.yml` set `NODE_ENV: production` and pass `CSRF_SECRET`/`WEBHOOK_SECRET` via `${...}`; extract hardcoded `HYBRID_*`/`CHUNK_*`/`GRAPH_*` into `${VAR}`; make `STORAGE_PUBLIC_ENDPOINT` a variable.
2. **Secrets:** replace values in `.env.example` with placeholders (`change-me`/`generate-with-openssl`), rotate `BETTER_AUTH_SECRET`/`HIAI_DOCS_API_KEY` if used in production.
3. **Caddy:** either remove `rate_limit` or build a custom Caddy image with `caddy-ratelimit`; restore 80/443 mapping for auto-TLS; validate with `caddy validate`.
4. **Reproducibility:** stop ignoring `bun.lock` (commit it) and replace `"latest"` with pinned ranges.
5. **Docs/CI:** update `docs/PRODUCTION_STATUS.md` and `CHANGELOG.md` for `v0.1.0`; align ports to a single source of truth; fix registry in `RELEASE_CHECKLIST.md` (`vgalibov` ↔ `hiai-gg`); validate Caddyfile in CI.
6. **Verification:** run full `bun test` against a separate `hiai_docs_test` (as in CI), update test count.

---

*File created by audit agent. No repository files were modified.*
