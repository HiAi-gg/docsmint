# hiai-docs Design Spec

**Date:** 2026-05-24
**Status:** Approved
**Author:** Agent + User

---

## 1. Overview

**hiai-docs** is a standalone, open-source, AI-native knowledge base and personal/team wiki. It is a self-hostable alternative to Outline, Docmost, and suitenumerique/docs, with a focus on:

- Markdown-first experience with rich WYSIWYG editing
- Built-in vector embeddings (RAG-ready out of the box)
- Excellent file/folder sharing with guest access
- Minimal dependencies and clean architecture
- Easy integration with AI agents (Mastra + Ollama)

**Tagline:** "Markdown + AI embeddings + simple sharing — without the bloat."

---

## 2. Architecture

### 2.1 Monorepo Structure

```
hiai-docs/
├── backend/              # Elysia API server (Bun)
├── frontend/             # SvelteKit 2 + shadcn-svelte + svelte-tiptap (TipTap v3)
├── packages/db/          # Drizzle schema + migrations (reusable)
├── package.json          # Bun workspace root
├── package.public.json   # Publishable version (no internal paths)
├── docker-compose.yml    # Public OSS compose
├── docker-compose.dev.yml # Local dev overrides (gitignored)
├── .env.example          # Template for all env vars
├── .gitignore
├── AGENTS.md             # Agent operational instructions
├── README.md             # Public-facing docs
├── LICENSE               # MIT
└── todo.md               # Development phases
```

### 2.2 Port Allocation

| Service | Port | Description |
|---------|------|-------------|
| API (Elysia) | 50700 | Backend REST API |
| Frontend (SvelteKit) | 50701 | Web UI |
| PostgreSQL | 5437 | Shared ai-core instance |
| Redis | 6384 | Shared ai-core instance |
| SeaweedFS | 9000/9021 | Object storage (API + Console) |
| Caddy | 80/443 | Reverse proxy |

---

## 3. Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | Bun | 1.3.14+ |
| Backend framework | Elysia | 1.4.28+ |
| ORM | Drizzle ORM | 0.45.2+ |
| Database | PostgreSQL + pgvector | 18.4 |
| Cache/Queue | Redis | 8.6+ |
| Auth | Better Auth | latest |
| Frontend | SvelteKit | 2.60+ |
| UI framework | Svelte | 5.55+ |
| UI components | shadcn-svelte (new-york style) | 1.2.7+ |
| Rich text editor | svelte-tiptap + TipTap v3 | latest |
| Validation | Zod | 3.24+ |
| Logging | Pino | 9.6+ |
| Icons | lucide-svelte | latest |
| CSS | Tailwind CSS v4 | latest |
| Module system | ESM-only | — |

---

## 4. Database Schema

All tables use `owner_id` for user-scoped isolation. `tenant_id` is reserved (nullable) for future multi-tenancy.

### 4.1 Tables

**users** — Better Auth managed
- id (uuid, PK), email, name, avatar_url, created_at, updated_at

**folders** — Hierarchical folder structure
- id (uuid, PK), owner_id (FK users), parent_id (self-ref, nullable), name, created_at, updated_at

**documents** — Core content
- id (uuid, PK), owner_id (FK users), folder_id (FK folders, nullable)
- title (text), content (text — markdown source), content_tipex (jsonb — Tipex AST, retained for backward compatibility after svelte-tiptap migration)
- metadata (jsonb — frontmatter, custom fields)
- embedding (vector(768) — pgvector)
- created_at, updated_at

**tags** — Document tags
- id (uuid, PK), owner_id (FK users), name, color

**document_tags** — Many-to-many
- document_id (FK), tag_id (FK)

**share_links** — Sharing tokens
- id (uuid, PK), document_id (FK, nullable), folder_id (FK, nullable)
- token (text, unique, indexed), password_hash (text, nullable)
- expires_at (timestamp, nullable), created_by (FK users), created_at

**guest_access** — Guest email grants
- id (uuid, PK), share_link_id (FK), guest_email, granted_at

**attachments** — File uploads (SeaweedFS)
- id (uuid, PK), document_id (FK), filename, mime_type, size (bigint), storage_key, created_at

**versions** — Document version history
- id (uuid, PK), document_id (FK), content (text), content_tipex (jsonb), created_by (FK users), created_at

### 4.2 Indexes

- documents: owner_id, folder_id, created_at, embedding (ivfflat/hnsw)
- folders: owner_id, parent_id
- share_links: token (unique), document_id, folder_id
- versions: document_id, created_at

---

## 5. Embedding Pipeline

### 5.1 Provider Configuration

```env
# Base URL for an OpenAI-compatible embedding API.
# Local Ollama example (no API key needed):
#   EMBEDDING_BASE_URL=http://localhost:11434/api
#   EMBEDDING_MODEL=bge-m3
# OpenAI example:
#   EMBEDDING_BASE_URL=https://api.openai.com/v1
#   EMBEDDING_API_KEY=sk-...
#   EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_BASE_URL=http://localhost:11434/api
EMBEDDING_API_KEY=
EMBEDDING_MODEL=bge-m3
```

### 5.2 Pipeline

1. Document saved/updated → trigger embedding job
2. Chunking: 500 tokens per chunk, 50 token overlap
3. Embed each chunk via configured provider
4. Store vectors in pgvector column
5. On failure: fallback provider, then dummy vector (graceful degradation)

### 5.3 Search

Hybrid search combining:
- PostgreSQL full-text search (tsvector on title + content)
- pgvector cosine similarity (semantic search)
- Weighted merge: 0.4 full-text + 0.6 semantic (configurable)

---

## 6. API Design

### 6.1 Routes (Elysia)

| Route | Method | Description |
|-------|--------|-------------|
| `/api/auth/*` | * | Better Auth endpoints |
| `/api/health` | GET | Health check |
| `/api/folders` | GET | List user folders (tree) |
| `/api/folders` | POST | Create folder |
| `/api/folders/:id` | PATCH | Rename/move folder |
| `/api/folders/:id` | DELETE | Delete folder (cascade) |
| `/api/documents` | GET | List documents (filter by folder, tag) |
| `/api/documents` | POST | Create document |
| `/api/documents/:id` | GET | Get document |
| `/api/documents/:id` | PATCH | Update document |
| `/api/documents/:id` | DELETE | Delete document |
| `/api/documents/:id/embeddings` | POST | Regenerate embeddings |
| `/api/documents/:id/versions` | GET | Version history |
| `/api/documents/:id/versions/:vid` | GET | Get specific version |
| `/api/documents/import` | POST | Upload .md file |
| `/api/documents/:id/export` | GET | Download as .md |
| `/api/search` | GET | Hybrid search (q, folder?, tag?) |
| `/api/tags` | GET | List user tags |
| `/api/tags` | POST | Create tag |
| `/api/tags/:id` | DELETE | Delete tag |
| `/api/share` | POST | Create share link |
| `/api/share/:token` | GET | Access shared content |
| `/api/share/:token` | DELETE | Revoke share link |
| `/api/attachments` | POST | Upload file to SeaweedFS |
| `/api/attachments/:id` | GET | Download attachment |

### 6.2 Auth

Better Auth with email/password + optional OAuth providers. Session-based auth with HTTP-only cookies.

### 6.3 Validation

All inputs validated with Zod schemas. Shared schemas in `packages/db/` for type reuse.

---

## 7. Frontend Design

### 7.1 shadcn-svelte Components

Installed components: Button, Badge, Input, Sheet, ScrollArea, Separator, Skeleton, Dialog, DropdownMenu, Tooltip, Tabs, Command, Resizable, Avatar, Card.

### 7.2 Pages

| Route | Description |
|-------|-------------|
| `/` | Dashboard: recent docs, quick search, folder tree |
| `/docs/[id]` | Document editor (svelte-tiptap WYSIWYG + raw MD toggle) |
| `/folders/[id]` | Folder view with document list |
| `/search` | Full hybrid search results page |
| `/shared/[token]` | Public shared content view (guest access) |
| `/settings` | Profile, embedding provider config |
| `/login` | Login page |
| `/register` | Registration page |

### 7.3 Layout

- Sidebar: collapsible folder tree + recent docs + tags
- Main content: editor or document list
- Header: search bar (Command component), user menu, settings
- Responsive: mobile-friendly with Sheet for sidebar

### 7.4 Editor

svelte-tiptap (TipTap v3) WYSIWYG as default mode. Toggle button switches to raw Markdown view with syntax highlighting. Content synced between both views via content_tipex (jsonb — legacy Tipex AST, retained for backward compatibility) and content (text) fields.

---

## 8. Sharing System

### 8.1 Flow

1. User clicks "Share" on document/folder
2. System generates short token (`/s/{token}`)
3. Optional: set password, expiration (1h/1d/7d/30d/never)
4. Optional: grant access to specific guest emails
5. Guest visits `/s/{token}` → sees content (password prompt if set)
6. Guest can get temporary Better Auth session for persistent access

### 8.2 Security

- Tokens are cryptographically random (nanoid, 21 chars)
- Passwords hashed with bcrypt
- Expired links return 410 Gone
- Rate limiting on share access (10 req/min per IP)

---

## 9. Docker Deployment

### 9.1 Services (docker-compose.yml)

```yaml
services:
  postgres:
    build: ./postgres
    ports: ["5437:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
    environment:
      POSTGRES_DB: hiai_docs
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}

  redis:
    image: redis:8-alpine
    ports: ["6384:6379"]

  seaweedfs:
    image: chrislusf/seaweedfs:3.85
    ports: ["9000:9000", "9021:9001"]
    volumes: [seaweedfs_data:/data]
    command: server /data --console-address ":9001"

  api:
    build:
      context: .
      dockerfile: Dockerfile.backend
    ports: ["50700:50700"]
    depends_on: [postgres, redis, seaweedfs]
    environment:
      DATABASE_URL: postgresql://${DB_USER}:${DB_PASSWORD}@postgres:5432/hiai_docs
      REDIS_URL: redis://redis:6379
      STORAGE_ENDPOINT: seaweedfs
      STORAGE_ACCESS_KEY: ${STORAGE_ACCESS_KEY}
      STORAGE_SECRET_KEY: ${STORAGE_SECRET_KEY}
      NODE_ENV: ${NODE_ENV:-production}

  web:
    build:
      context: .
      dockerfile: frontend/Dockerfile
    ports: ["50701:50701"]
    depends_on: [api]

  caddy:
    build:
      context: .
      dockerfile: Dockerfile.caddy
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
    profiles: [caddy]
```

### 9.2 .env.example

```env
# Database
DB_USER=aiuser
DB_PASSWORD=changeme
DB_PORT=5437
DATABASE_URL=postgresql://aiuser:changeme@localhost:5437/hiai_docs

# Auth
BETTER_AUTH_SECRET=change-me-generate-with-openssl-rand-hex-32
BETTER_AUTH_URL=http://localhost:50700
CSRF_SECRET=change-me-generate-with-openssl-rand-hex-32
WEBHOOK_SECRET=change-me-generate-new-key-for-webhooks
CORS_ORIGINS=http://localhost:50701,http://127.0.0.1:50701

# SeaweedFS
STORAGE_ACCESS_KEY=minioadmin
STORAGE_SECRET_KEY=changeme
STORAGE_BUCKET=hiai-docs

# Embeddings
EMBEDDING_BASE_URL=http://localhost:11434/api
EMBEDDING_API_KEY=
EMBEDDING_MODEL=bge-m3

# GraphRAG (optional)
GRAPH_EXTRACT_ENABLED=false
GRAPH_SEARCH_ENABLED=false
GRAPH_EXTRACT_BASE_URL=http://localhost:11434/v1
GRAPH_EXTRACT_MODEL=llama3.1
GRAPH_EXTRACT_MIN_CONFIDENCE=0.5

# Search ranking
HYBRID_TEXT_WEIGHT=0.4
HYBRID_SEMANTIC_WEIGHT=0.6
GRAPH_EXPANSION_BOOST=0.3

# Chunking
CHUNK_TARGET_TOKENS=500
CHUNK_OVERLAP_TOKENS=50

# Re-embed batch caps
FOLDER_REEMBED_BATCH_SIZE=100
CATEGORY_REEMBED_BATCH_SIZE=100
TAG_REEMBED_BATCH_SIZE=500

# App
API_PORT=50700
WEB_PORT=50701
NODE_ENV=production
HIAI_DOCS_API_KEY=change-me-generate-new-key
OWNER_ID=your-user-uuid-from-auth
```

---

## 10. Open Source Considerations

- All paths, keys, and dependencies configured via .env
- .gitignore excludes .env, node_modules, dist, .svelte-kit, .next
- package.public.json strips internal workspace paths for npm publish
- MIT license
- Contributing guide in README
- Docker compose works standalone with .env.example as template

---

## 11. Testing Strategy

- **Backend:** Bun test runner for unit/integration tests
- **Frontend:** Vitest for component tests
- **E2E:** agent-browser (Playwright FORBIDDEN)
- **Database:** Drizzle migration tests
- **Embedding:** Mock provider for unit tests, real Ollama for integration

---

## 12. Future (Phase 4+)

- Real-time collaboration (Yjs or similar)
- Comments & mentions
- Database blocks / simple tables
- Mobile-responsive improvements
- Export entire workspace as zip
- Mastra Skills for bot integration
- WebSocket for live updates
