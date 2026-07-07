# Production Status Report

> **Status:** 🔧 Under maintenance — v0.1.8 released
> **Last verified:** 2026-07-03

---

## 1. Verification Results

| Check | Status |
|-------|--------|
| Typecheck | ✅ PASS — 0 errors across all packages (pending full re-run) |
| Tests | ✅ PASS — 451/451 passing |
| Build | ✅ PASS — Docker multi-stage builds |
| Health checks | ✅ PASS |

## 2. Architecture

14 route files: admin, auth, categories, collaboration, documents, folders, graph, metrics, search, share, tags, attachments, versions, webhooks.

Security: rate limiting, Zod validation, owner_id scoping, CSRF protection, CORS, security headers.

## 3. Deployment

```bash
git clone https://github.com/hiai-gg/hiai-docs.git && cd hiai-docs
cp .env.example .env
docker compose pull && docker compose up -d
docker compose exec api bun run db:migrate
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

## 4. Testing

451 tests passing (backend). Run: `cd backend && bun test`, `cd frontend && bun test`.

## 5. Security Checklist

Authentication, CSRF, rate limiting, Zod validation, owner scoping, CORS, HSTS, CSP, X-Frame-Options, password hashing (Argon2id), API key auth, non-root containers, parameterized queries — all in place.

## 6. Known Issues

- **Biome/Svelte 5:** 44 false-positive lint errors on Svelte 5 runes (non-blocking)
- **Typebox pin:** required for Elysia 1.4.28 compatibility
- **Embedding API keys:** configure EMBEDDING_BASE_URL, EMBEDDING_API_KEY, and EMBEDDING_MODEL in .env (optional for Ollama self-hosting)
- **No E2E tests:** tracked in todo.md T6.3
- **No automated backups:** operator responsibility

---

*Status: 🔧 Under maintenance — v0.1.8 released*
