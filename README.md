# hiai-docs

**The lightest AI-native self-hosted knowledge vault.**

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/hiai-gg/hiai-docs?sort=semver)](https://github.com/hiai-gg/hiai-docs/releases)
[![Stars](https://img.shields.io/github/stars/hiai-gg/hiai-docs)](https://github.com/hiai-gg/hiai-docs/stargazers)
[![CI](https://github.com/hiai-gg/hiai-docs/actions/workflows/ci.yml/badge.svg)](https://github.com/hiai-gg/hiai-docs/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/Runtime-Bun_1.3-black?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Svelte](https://img.shields.io/badge/Svelte-5.x-FF3E00?logo=svelte&logoColor=white)](https://svelte.dev)
[![Elysia](https://img.shields.io/badge/Elysia-1.4-lightgrey?logo=elysia&logoColor=white)](https://elysiajs.com)
[![Tailwind_CSS](https://img.shields.io/badge/Tailwind_CSS-v4-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Drizzle_ORM](https://img.shields.io/badge/Drizzle_ORM-0.45-C5F74F?logo=drizzle&logoColor=black)](https://orm.drizzle.team)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

hiai-docs is a lightweight **self-hosted knowledge base** built for users who want speed, full data ownership, and strong AI capabilities without heavy enterprise overhead. 

If you are looking for a **local LLM knowledge base** or a **lightweight Outline alternative** / **Docmost alternative**, hiai-docs offers an elegant, **RAG-ready knowledge vault** that automatically generates vector embeddings on every save, supports hybrid semantic search, and provides a clean REST API for AI agent integration.

---

## Table of Contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Quick Start](#quick-start)
- [Stack](#stack)
- [Comparison](#comparison)
- [Project Structure](#project-structure)
- [Configuration](#configuration)
- [API Documentation](#api-documentation)
- [Contributing](#contributing)
- [License](#license)
- [Related Projects](#related-projects)

---

<img width="1920" height="974" alt="docs" src="https://github.com/user-attachments/assets/94701d01-a361-4ca1-b16d-de2a0c64d684" />


## Features

- **Rich WYSIWYG editor** — powerful visual editing with TipTap v3 + svelte-tiptap
- **AI-native** — automatic chunking + vector embeddings on every save
- **Semantic search** — hybrid full-text + pgvector search
- **Folder hierarchy** — nested folders to organize your documents
- **Sharing** — token-protected links with password, expiration, and guest access
- **Import / Export** — support for Markdown (.md) files
- **Agent-ready** — clean REST API for AI agents (Mastra compatible and others)
- **Self-hosted** — full data ownership with minimal resource usage

## Screenshots
<img width="999" height="594" alt="docs_screenshot" src="https://github.com/user-attachments/assets/1ba409e7-32cf-40d3-ae30-f8369e48cb53" />

---

## Quick Start

### Docker (Production-style)

```bash
git clone https://github.com/hiai-gg/hiai-docs.git
cd hiai-docs
cp .env.example .env
# Edit .env with your settings

docker compose up -d
```

Open http://localhost:50701

## Agentic Quickstart (AI-Powered Setup)

Don't want to run setup commands manually? Copy-paste this unified prompt into your AI assistant (OpenCode, Claude Code, Cursor, Copilot, etc.) and let it do the work:

```text
Set up and launch the hiai-docs project on my local system:
1. Clone the repository at https://github.com/hiai-gg/hiai-docs (if not already cloned)
2. Copy .env.example to .env
3. Generate a secure random auth secret using openssl or a secure generator, and set it as BETTER_AUTH_SECRET in .env
4. Install all dependencies with "bun install"
5. Boot up the developer Docker container dependencies (Postgres, Redis, MinIO) by running:
    bun run docker:dev
6. Generate and apply database migrations to setup schemas by running:
   bun run db:push
7. Spin up the application services (Elysia API and SvelteKit web) in development/watch mode:
   bun run dev
8. Verify health status by checking:
   - SvelteKit Web UI: http://localhost:50701
   - Elysia API Health: http://localhost:50700/api/health
```

### Local Development (Recommended for hacking)

Two equivalent workflows — pick one. Both give you live-reload at http://localhost:50701.

#### Option A — Hybrid (infra in Docker, api+web on host)

This is the fastest dev loop. `bun run dev` runs `vite dev` (port 50701) and `bun --watch` for the api in parallel; both auto-reload on file changes.

```bash
# 1. Install JS deps once
bun install

# 2. Start infrastructure in Docker
bun run docker:dev          # brings up postgres, redis, minio

# 3. Push DB schema (one-time, or after schema changes)
bun run db:push

# 4. Start api + web on the host, with live reload
bun run dev
# vite dev → http://localhost:50701
# api      → http://localhost:50700
```

Stop the infra when done: `bun run stop`

#### Option B — Full Docker with live-reload bind mounts

`docker-compose.dev.yml` mounts the source into the api/web containers, so editing a file on the host is picked up inside the container (vite HMR + bun --watch). Useful when you want everything isolated in Docker.

```bash
bun run docker:dev
# Open http://localhost:50701
```

> The `web` and `api` services in `docker-compose.dev.yml` bind `./:/app`, so any edit on the host is reflected inside the container without rebuilding.

### Why is port 50701 special?

The frontend dev server is pinned to port 50701 in `frontend/vite.config.ts` with `strictPort: true`. That last flag is important: if 50701 is already taken (e.g. a stale container from a previous run), vite will **fail loudly** instead of silently falling back to 5173 — which would leave you staring at an old build at http://localhost:50701. If you see "port 50701 in use", run `docker compose down` (or `bun run stop`) and retry.

### Troubleshooting

#### Docker: permission denied

If you get `permission denied` when running Docker commands:

```bash
# Add your user to the docker group
sudo usermod -aG docker $USER

# Log out and back in, or run:
newgrp docker
```

Then verify: `docker ps` should work without `sudo`.

- **Port 50701 already in use** — `docker compose down` to stop stale containers, then retry `bun run dev` or `bun run docker:dev`.
- **Changes not showing up** — `bun run dev` already wires HMR. If running via Docker, confirm the bind mount is in `docker-compose.dev.yml` (not the prod `docker-compose.yml`, which builds an immutable image).
- **`bun install` complains about the lockfile** — ensure `bun.lock` is in sync: `bun install`.
- **Docker `web` build works without paraglide patches** — As of `@inlang/paraglide-js@2.x`, the `@inlang/sdk@2.x` rewrite no longer emits the `data:` URLs that triggered Bun's `NameTooLong` error. The old `sed` patch on `frontend/Dockerfile` was removed. i18n is now driven by `@inlang/paraglide-js@2.x` directly (the SvelteKit adapter is deprecated) via `paraglideVitePlugin` in `vite.config.ts` and `paraglideMiddleware` in `src/hooks.server.ts`.

---

## Stack

| Layer | Technology |
|-------|----------|
| Runtime | [Bun](https://bun.sh) 1.3.14+ |
| Backend | [Elysia](https://elysiajs.com) 1.4.28+ |
| ORM | [Drizzle ORM](https://orm.drizzle.team) 0.45.2+ |
| Database | [PostgreSQL](https://postgresql.org) 18 + [pgvector](https://github.com/pgvector/pgvector) |
| Cache | [Redis](https://redis.io) 8.6+ |
| Auth | [Better Auth](https://better-auth.com) |
| Frontend | [SvelteKit](https://kit.svelte.dev) 2.60+ |
| UI | [shadcn-svelte](https://shadcn-svelte.com) (new-york style) |
| Editor | [svelte-tiptap](https://github.com/sibiraj-s/svelte-tiptap) + [TipTap v3](https://tiptap.dev) |
| Embeddings | OpenAI-compatible API (configurable) |
| Storage | [MinIO](https://min.io) (S3-compatible) |

---

## Comparison with other self-hosted solutions

| Project            | Best For                              | hiai-docs vs them                              | License / Limitations                          |
|--------------------|---------------------------------------|------------------------------------------------|------------------------------------------------|
| **La Suite Docs**  | Government & teams, strong block editor | Much lighter and faster                        | MIT (fully unrestricted)                       |
| **Outline**        | Teams with integrations               | Lighter + built-in RAG out of the box          | BSL 1.1 – free for self-hosting, restrictions on offering as hosted service |
| **Docmost**        | Confluence / Notion replacement       | Simpler, faster, lower resource usage          | AGPL-3.0 (Community) – fully open, Enterprise features extra |
| **Wiki.js**        | Markdown + Git sync                   | Better AI & semantic search                    | AGPL-3.0                                       |
| **hiai-docs**      | **Lightweight AI-first vault**        | —                                              | MIT (fully unrestricted)                       |
| **AFFiNE**         | Notion + whiteboard experience        | Much lighter, far lower overhead               | MIT (frontend) + restrictive EE license (backend) – production limits (10 users / 100 GB on free tier) |
| **Trilium Notes**  | Personal knowledge + scripting        | Better sharing & semantic search               | AGPL-3.0                                       |
| **SilverBullet**   | Extensible Markdown notes             | Better AI integration & sharing                | MIT                                            |

**hiai-docs** sits in the **lightweight AI-first** niche — ideal when you want built-in embeddings, fast performance, and minimal resource consumption rather than heavy collaboration features or enterprise complexity.

---

## Project Structure

```
hiai-docs/
├── backend/              # Elysia REST API
│   ├── src/
│   │   ├── api/          # Routes + middleware
│   │   ├── lib/          # Shared utilities
│   │   ├── embedding/    # Embedding pipeline
│   │   └── index.ts      # Entry point
│   ├── package.json
│   └── tsconfig.json
├── frontend/             # SvelteKit web UI
│   ├── src/
│   │   ├── routes/       # Pages
│   │   ├── lib/          # Components + utils
│   │   └── app.css       # Tailwind + theme
│   ├── package.json
│   └── svelte.config.js
├── packages/db/          # Drizzle schema + migrations
│   ├── src/
│   │   ├── schema.ts     # Table definitions
│   │   ├── migrations/   # SQL migrations
│   │   └── index.ts      # DB client
│   └── package.json
├── docker-compose.yml    # Production Docker setup
├── .env.example          # Environment template
├── AGENTS.md             # Agent instructions
├── README.md             # This file
├── LICENSE               # MIT
└── todo.md               # Development roadmap
```

---

## Configuration

All configuration via environment variables. Copy `.env.example` to `.env` and configure:

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_USER` | aiuser | PostgreSQL username |
| `DB_PASSWORD` | changeme | PostgreSQL password |
| `BETTER_AUTH_SECRET` | — | Auth secret (generate random) |
| `BETTER_AUTH_URL` | http://localhost:50700 | Auth base URL |
| `MINIO_ACCESS_KEY` | minioadmin | MinIO access key |
| `MINIO_SECRET_KEY` | minioadmin | MinIO secret key |
| `EMBEDDING_BASE_URL` | — | Base URL for OpenAI-compatible embedding API (optional) |
| `EMBEDDING_API_KEY` | — | API key for embedding service (leave empty for local inference) |
| `EMBEDDING_MODEL` | — | Embedding model name |
| `CORS_ORIGINS` | http://localhost:50701 | Comma-separated allowed origins (required for local dev) |

See `.env.example` for full list of all configuration variables.

---

## API Documentation

REST API available at `http://localhost:50700/api/`.

Key endpoints:
- `POST /api/documents` — Create document
- `GET /api/documents/:id` — Get document with tags
- `GET /api/search?q=query` — Hybrid full-text + semantic search
- `POST /api/share` — Create share link
- `GET /api/share/:token` — Access shared content (public)
- `POST /api/documents/:id/attachments` — Upload image
- `WS /ws/collab/:documentId` — Real-time collaborative editing

Full API documentation available in [docs/API.md](docs/API.md).

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing`)
3. Commit changes (`git commit -m 'feat: add amazing feature'`)
4. Push to branch (`git push origin feature/amazing`)
5. Open a Pull Request

### Development Rules

- **Bun only** — no npm/yarn
- **ESM only** — no CommonJS
- **TypeScript strict** — no `any`
- **English only** — code, comments, docs, commits
- **No Playwright** — use agent-browser for E2E

---

## License

[MIT](LICENSE)

---

## Related Projects

Part of the [HiAi](https://hiai.gg) open-source ecosystem:

| Project | Description |
|---------|-------------|
| [hiai-opencode](https://github.com/hiai-gg/hiai-opencode) | AI coding agent |
| [hiai-observe](https://github.com/hiai-gg/hiai-observe) | Observability platform |
