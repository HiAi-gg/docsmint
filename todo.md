# hiai-docs — Development Roadmap

> 🧭 **Живой статус этого проекта.** Считается готовым; для экосистемы — только унификация/интеграция:
> [`HIAI_PROJECTS_ROADMAP.md`](../HIAI_PROJECTS_ROADMAP.md) (раздел «hiai-docs», фазы DOC1–DOC2) +
> [`HIAI_CONVENTIONS.md`](../HIAI_CONVENTIONS.md) (docs = источник дизайн-токенов).

> Multi-agent development plan. 128 files created across 7 phases.

---

## Phase 0 — Foundation ✅ DONE

### T0.1 — Monorepo scaffold ✅
- [x] Root `package.json` with Bun workspaces
- [x] Root `tsconfig.json` (ESNext, bundler, strict)
- [x] Root `.gitignore`
- [x] `.env.example` with all required variables
- [x] `LICENSE` (MIT)
- [x] `scripts/prework_backup.sh`

### T0.2 — Docker infrastructure ✅
- [x] `docker-compose.yml` (7 services)
- [x] `docker-compose.dev.yml` (shared infra: PG 5433, Redis 6380, Ollama 11434, MinIO 9010)
- [x] `Caddyfile`, `backend/Dockerfile`, `frontend/Dockerfile`, `init.sql`

### T0.3 — Database package ✅
- [x] `packages/db/` — 9 tables (users, folders, documents, tags, document_tags, share_links, guest_access, attachments, versions)
- [x] pgvector(1024) for embeddings, pg_trgm for fuzzy search
- [ ] `packages/db/src/migrations/` — generated on first `bun run db:generate`

### T0.4 — Backend scaffold ✅
- [x] `backend/` — Elysia entry point, config (Zod), logger (Pino), db, redis, minio clients

### T0.5 — Frontend scaffold ✅
- [x] `frontend/` — SvelteKit, Tailwind v4, shadcn-svelte config, root layout

### T0.6 — shadcn-svelte components ✅
- [x] Button, Badge, Input, Card, Dialog, DropdownMenu, Label, Switch, Tabs, Textarea

### T0.7 — Auth setup ✅
- [x] `backend/src/lib/auth.ts` — Better Auth config
- [x] `backend/src/api/middleware/auth.ts` — Session middleware
- [x] `backend/src/api/routes/auth.ts` — Login/register/logout/session
- [x] `frontend/src/routes/login/+page.svelte`
- [x] `frontend/src/routes/register/+page.svelte`
- [x] `frontend/src/lib/auth-client.ts`

---

## Phase 1 — Backend API ✅ DONE

### T1.1 — Folders API ✅
- [x] `backend/src/api/routes/folders.ts` — CRUD (GET, POST, PATCH, DELETE)

### T1.2 — Documents API ✅
- [x] `backend/src/api/routes/documents.ts` — CRUD + pagination + tag filter

### T1.3 — Search API ✅
- [x] `backend/src/api/routes/search.ts` — Full-text (tsvector) + suggest (pg_trgm)

### T1.4 — Sharing API ✅
- [x] `backend/src/api/routes/share.ts` — CRUD + public access + rate limiting

### T1.5 — Tags API ✅
- [x] `backend/src/api/routes/tags.ts` — CRUD + document tagging

---

## Phase 2 — Embedding Pipeline ✅ DONE

### T2.1 — Embedding core ✅
- [x] `backend/src/embedding/chunker.ts` — 500-token chunks, 50 overlap
- [x] `backend/src/embedding/providers/ollama.ts` — Ollama provider
- [x] `backend/src/embedding/providers/openrouter.ts` — OpenRouter provider
- [x] `backend/src/embedding/index.ts` — Provider factory + fallback (zero vector on failure)

### T2.2 — Embedding integration ✅
- [x] `backend/src/lib/embedding-queue.ts` — Redis async queue + background worker
- [x] Wired into document create/update routes

---

## Phase 3 — Frontend Pages ✅ DONE

### T3.1 — Dashboard + Sidebar ✅
- [x] `frontend/src/routes/+page.svelte` — Dashboard with doc grid + search
- [x] `frontend/src/lib/components/sidebar/Sidebar.svelte` — Collapsible sidebar
- [x] `frontend/src/lib/components/sidebar/FolderTree.svelte` — Nested folder tree
- [x] `frontend/src/lib/components/sidebar/RecentDocs.svelte` — Recent docs
- [x] `frontend/src/lib/components/sidebar/TagList.svelte` — Tag badges
- [x] `frontend/src/lib/components/SearchBar.svelte` — Search input with ⌘K

### T3.2 — Document Editor ✅
- [x] `frontend/src/routes/docs/[id]/+page.svelte` — Editor page
- [x] `frontend/src/routes/docs/[id]/+page.ts` — Load function
- [x] `frontend/src/lib/components/editor/TipexEditor.svelte` — TipTap wrapper
- [x] `frontend/src/lib/components/editor/MarkdownToggle.svelte` — Raw MD view
- [x] `frontend/src/lib/components/editor/EditorToolbar.svelte` — Formatting toolbar
- [x] `frontend/src/lib/components/editor/DocumentTitle.svelte` — Editable title

### T3.3 — Folder View ✅
- [x] `frontend/src/routes/folders/[id]/+page.svelte` — Folder contents
- [x] `frontend/src/routes/folders/[id]/+page.ts` — Load function
- [x] `frontend/src/lib/components/DocumentCard.svelte` — Document card
- [x] `frontend/src/lib/components/FolderCard.svelte` — Folder card

### T3.4 — Search Page ✅
- [x] `frontend/src/routes/search/+page.svelte` — Search results with highlighting
- [x] `frontend/src/routes/search/+page.ts` — Load function
- [x] `frontend/src/lib/components/SearchResult.svelte` — Result card with `<mark>` highlights

### T3.5 — Settings + Share ✅
- [x] `frontend/src/routes/settings/+page.svelte` — Settings with tabs
- [x] `frontend/src/lib/components/ShareDialog.svelte` — Share link dialog
- [x] `frontend/src/lib/components/ShareLink.svelte` — Share link display
- [x] `frontend/src/lib/components/AttachmentUpload.svelte` — File upload zone

---

## Phase 4 — Shared Content View ✅ DONE

### T4.1 — Public share page ✅
- [x] `frontend/src/routes/s/[token]/+page.svelte` — Public shared view (password prompt, doc/folder display)
- [x] `frontend/src/routes/s/[token]/+page.ts` — Load function
- [x] Rate limiting on backend (10 req/min per IP)

---

## Phase 5 — Version History ✅ DONE

### T5.1 — Version tracking
- [x] Backend: auto-save version on document create/update (in documents.ts)
- [x] Backend: GET /api/documents/:id/versions route
- [x] Backend: GET /api/documents/:id/versions/:vid route
- [x] `frontend/src/lib/components/VersionHistory.svelte`
- [x] `frontend/src/lib/components/VersionDiff.svelte`

---

## Phase 6 — Integration & Polish ✅ DONE

### T6.1 — API integration wiring
- [x] Frontend pages use real API calls with mock fallback
- [x] Loading states and error handling added
- [x] CORS configured in backend

### T6.2 — UI polish
- [x] Dark mode CSS variables (app.css)
- [x] Mobile responsive layout
- [x] Keyboard shortcuts (Cmd+K search)

### T6.3 — E2E testing
- [ ] Tests with agent-browser (deferred to manual testing)

---

## Phase 7 — Documentation & Deploy ✅ DONE

### T7.1 — API documentation
- [x] `docs/API.md` — REST API reference
- [x] `docs/DEPLOYMENT.md` — Deployment guide

### T7.2 — Contributing guide
- [x] `CONTRIBUTING.md`
- [x] `docs/ARCHITECTURE.md`

### T7.3 — Publish preparation
- [x] `package.public.json` — public publishable version

---

## Summary

| Phase | Status | Files |
|-------|--------|-------|
| Phase 0 — Foundation | ✅ DONE | ~40 files |
| Phase 1 — Backend API | ✅ DONE | 6 route files |
| Phase 2 — Embedding | ✅ DONE | 5 files |
| Phase 3 — Frontend | ✅ DONE | ~60 files (pages + components + UI) |
| Phase 4 — Share View | ✅ DONE | 2 files |
| Phase 5 — Versions | ✅ DONE | 5 files |
| Phase 6 — Integration | ✅ DONE | API wiring + loading states |
| Phase 7 — Docs & Deploy | ✅ DONE | 4 docs files |
| Phase 8 — Release | 🔄 IN PROGRESS | Docs overhaul, release checklist, CI |

**Total: 134 source files, 0 TS errors in backend**

---

## Phase 8 — Release Preparation 🔄 IN PROGRESS

### T8.1 — Documentation overhaul
- [x] Add Table of Contents to README.md
- [x] Verify API.md matches actual backend routes
- [x] Create RELEASE_CHECKLIST.md

### T8.2 — Pre-release cleanup
- [ ] Bump version to v0.0.1
- [ ] Regenerate secrets
- [ ] Build Docker images
- [ ] Run full test suite
- [ ] Tag release
- [ ] Push to GitHub
- [ ] Create GitHub release
