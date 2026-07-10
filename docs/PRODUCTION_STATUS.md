# Production Status Report

> **Status:** 🟡 Release Candidate — v0.2.6
> **Last verified:** 2026-07-10

---

## 1. Verification Results

| Check | Status |
|-------|--------|
| Typecheck | ✅ PASS — 0 errors across all packages |
| Tests | ✅ PASS — 531/531 passing (backend 483 + frontend 48) |
| Build | ✅ PASS — backend, frontend, SDK, and custom PostgreSQL images |
| Health checks | ✅ PASS |

## 2. Architecture

17 route files: admin, attachments, auth, categories, collaboration, documents, folders, graph, keys, metrics, plugins, search, share, tags, versions, visibility, webhooks.

Security: rate limiting, Zod validation, owner_id scoping, CSRF protection, CORS, security headers.

## 3. Deployment

```bash
git clone https://github.com/hiai-gg/hiai-docs.git && cd hiai-docs
cp .env.example .env
docker compose pull && docker compose up -d
# From the repository root; the runtime image does not ship migration source.
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

## 4. Testing

531 tests passing (backend 483 + frontend 48). Run: `bun run test`.

## 5. Security Checklist

Authentication, CSRF, rate limiting, Zod validation, owner scoping, CORS, HSTS, CSP, X-Frame-Options, password hashing (Argon2id), API key auth, non-root containers, parameterized queries — all in place.

## 6. Known Issues

- **Typebox pin:** required for Elysia 1.4.28 compatibility
- **Embedding provider:** configure EMBEDDING_BASE_URL, EMBEDDING_API_KEY, and EMBEDDING_MODEL in .env (optional for Ollama self-hosting)
- **No automated backups:** operator responsibility
- **GraphRAG:** All G1-G9 and N1 audit items resolved. See GRAPHRAG_AUDIT.md.

---

*Status: 🟡 Release Candidate — v0.2.6*
