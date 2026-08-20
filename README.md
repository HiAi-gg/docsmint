# DocsMint

**A self-hosted AI-native knowledge workspace and installable PWA for people,
applications, and AI agents.**

DocsMint stores documents in a structured JSON editor model first. Markdown is
the convenient second format for editing, importing, and exporting content.
Automatic chunking, 1024-dimensional embeddings, multilingual hybrid search,
and GraphRAG make the same knowledge base useful to people, applications, and
agents through the web application, REST API, TypeScript SDK, CLI, and MCP
server.

[![Apache-2.0 License](https://img.shields.io/badge/License-Apache--2.0-green.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/hiai-gg/docsmint?sort=semver)](https://github.com/hiai-gg/docsmint/releases)
[![npm](https://img.shields.io/npm/v/@hiai-gg/docsmint?logo=npm)](https://www.npmjs.com/package/@hiai-gg/docsmint)
[![Docker Pulls](https://img.shields.io/docker/pulls/vgalibov/docsmint?logo=docker)](https://hub.docker.com/r/vgalibov/docsmint)
[![Stars](https://img.shields.io/github/stars/hiai-gg/docsmint)](https://github.com/hiai-gg/docsmint/stargazers)
[![CI](https://github.com/hiai-gg/docsmint/actions/workflows/ci.yml/badge.svg)](https://github.com/hiai-gg/docsmint/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/Runtime-Bun_1.3-black?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Svelte](https://img.shields.io/badge/Svelte-5.x-FF3E00?logo=svelte&logoColor=white)](https://svelte.dev)
[![Elysia](https://img.shields.io/badge/Elysia-1.4-lightgrey?logo=elysia&logoColor=white)](https://elysiajs.com)
[![Tailwind_CSS](https://img.shields.io/badge/Tailwind_CSS-v4-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Drizzle_ORM](https://img.shields.io/badge/Drizzle_ORM-0.45-C5F74F?logo=drizzle&logoColor=black)](https://orm.drizzle.team)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![MCP Badge](https://lobehub.com/badge/mcp/hiai-gg-docsmint?style=plastic)](https://lobehub.com/mcp/hiai-gg-docsmint)

<img width="1920" height="974" alt="DocsMint installable document workspace" src="https://github.com/user-attachments/assets/94701d01-a361-4ca1-b16d-de2a0c64d684" />

## Why DocsMint?

- **Write naturally** in a rich visual editor or raw Markdown.
- **Find meaning, not only keywords** with exact, lexical, fuzzy, vector,
  multilingual expansion, and graph retrieval fused through RRF.
- **Keep retrieval current** with automatic, incremental chunking and
  re-embedding after document or metadata changes.
- **Connect agents directly** through REST, a typed SDK, CLI, or MCP.
- **Control access** with global keys or category-scoped `read`, `edit`, and
  `write` permissions.
- **Own the full stack**: application data, vectors, graph, queue, and files run
  on infrastructure you control.

## What's new in DocsMint 0.6.7?

- **Reliable HTTPS sessions.** Every protected SvelteKit route accepts Better
  Auth's secure production cookie as well as the local-development cookie.
- **Cleaner retrieval.** Deleted documents are excluded before exact, lexical,
  fuzzy, vector, chunk, and graph ranking.
- **Explicit GraphRAG providers.** Entity extraction requires its own
  chat-completion URL and never sends chat requests to an embedding endpoint.
- **Safer self-host defaults.** Auth origins are validated configuration, the
  SeaweedFS Filer UI binds to loopback, folder moves refresh knowledge
  metadata, and backups exclude `.env`.

DocsMint 0.6.7 includes the safe index recovery introduced in 0.6.6:

- **Safe explicit index recovery.** Admin document reindexing keeps the active
  generation searchable until a new generation has passed embedding, graph,
  summary, and finalize stages.
- **Truthful queue admission.** Maintenance requests force a replacement
  generation and report an error when durable enqueue fails instead of
  returning a false-positive success.
- **Verified MCP distribution.** The official MCP Registry manifest, npm stdio
  package, hosted Streamable HTTP endpoint, bundled Skill, prompts, resources,
  and 17-tool catalog remain one versioned contract.

DocsMint 0.6.6 includes the registry metadata fixes released in 0.6.3-0.6.5
and the complete MCP foundation introduced in 0.6.2:

- **Official MCP identity.** DocsMint now publishes the verified
  `io.github.HiAi-gg/docsmint` registry identity for both the npm stdio server
  and the hosted Streamable HTTP endpoint.
- **One capability implementation.** The public `@hiai-gg/docsmint/mcp`
  contract lets hosts provide a scoped API client while reusing the same 17
  tools, two prompts, three resources, and bundled document-manager Skill.
- **Current protocol runtime.** The MCP server uses the stable v2 server
  package and retains compatible stdio negotiation for existing clients.

DocsMint 0.6.2 includes the reliable knowledge refresh and scoped automation
foundation introduced in 0.6.1:

- **Reliable knowledge refreshes.** Explicit full reindexing now supersedes
  failed or stuck generations, retries release stale extraction claims, and
  publishes embeddings, summaries, and graph projections only for the current
  document generation.
- **Safer scoped automation.** Global keys can manage the complete document
  domain, while category keys stay confined to their category, folders,
  documents, tags, graph traversal, and index operations according to explicit
  `read`, `edit`, and `write` permissions.
- **Portable agent integration.** The MCP package exposes 17 document-manager
  tools, two reusable prompts, three context resources, and a bundled Skill,
  with Bunx, NPX, and local-checkout installation paths.
- **Compatible frontend packaging.** Published frontend entrypoints resolve the
  canonical hiai-ui exports used by the source build and packed consumers.

DocsMint 0.6.1 includes the mobile and PWA foundation introduced in 0.6.0:

- **Installable, update-safe PWA.** A versioned service worker, responsive app
  shell, install prompt, and deterministic offline fallback make DocsMint feel
  at home on desktop and mobile browsers.
- **Private offline reading and explicit drafts.** Identity-partitioned local
  snapshots keep selected documents readable offline. Drafts autosave locally,
  then return through a deliberate review-and-apply flow after reconnecting;
  DocsMint never silently replays offline mutations.
- **Touch-safe mobile navigation.** Sidebar document actions, Copy controls, and
  overflow menus remain reachable on touch devices without depending on hover,
  with accessible targets and narrow-screen layouts.
- **A flexible editor contract.** Reactive visual/Markdown mode preferences,
  Minimal toolbar support, and a reusable compact TipTap editor let hosts match
  the writing surface to the task without forking editor internals.
- **Stable document discovery.** The public API and TypeScript SDK provide
  deterministic cursor pagination and global sorting by title, category,
  folder, or update time, with canonical category and folder metadata.
- **Clear public and restricted sharing.** Share creation exposes the resulting
  URL for both public links and restricted invitation workflows, with an
  explicit Copy action that works on narrow screens.
- **Knowledge built for agents.** REST, the typed SDK, CLI, and MCP server expose
  scoped document operations, while multilingual hybrid search and GraphRAG
  help people and AI agents retrieve connected knowledge instead of isolated
  keyword matches.

DocsMint combines an installable self-hosted PWA knowledge base, mobile document
workspace, offline reading, local drafts, multilingual semantic search,
GraphRAG, MCP, a TypeScript SDK, CLI, and composable frontend hosts in one
open-source system.

For self-hosted customization, see [PWA hosting](docs/PWA_HOSTING.md) and
[extension points](docs/EXTENDING.md).

## Fastest installation: give this prompt to your agent

If you are installing DocsMint through an AI coding agent, use this path first.
It keeps the setup to Docker plus one provider choice and avoids unnecessary
source-code changes.

```text
Install DocsMint from https://github.com/HiAi-gg/docsmint.
Verify Docker and Docker Compose v2, clone the repository, and run
`bash scripts/quickstart.sh`. Do not print or commit .env. Ask me to enter only
an OpenRouter key or select Ollama, then run quickstart again. Verify
http://localhost:50701, http://localhost:50700/api/health, and
`docker compose ps`. Do not replace Bun, rewrite migrations, disable GraphRAG,
or delete volumes.
```

After startup, open **http://localhost:50701** and create the first account.
For manual installation, use the Docker quickstart below.

## Quickstart

### Requirements

- Docker Engine or Docker Desktop
- Docker Compose v2
- One of:
  - an [OpenRouter](https://openrouter.ai/) API key; or
  - a local [Ollama](https://ollama.com/) instance

### Start with Docker

```bash
git clone https://github.com/HiAi-gg/docsmint.git
cd docsmint
bash scripts/quickstart.sh
```

On its first run, the script creates an ignored root `.env`, generates the
database, authentication, and storage secrets, builds the PostgreSQL image,
applies migrations, and starts the complete application.

For OpenRouter, add one value to `.env` and run the script again:

```dotenv
OPENROUTER_API_KEY=sk-or-your-key
```

For Ollama, select the local provider instead:

```dotenv
AI_PROVIDER=ollama
OLLAMA_PORT=11434
```

Then make sure the configured local models are available:

```bash
ollama pull bge-m3
ollama pull qwen3:8b
bash scripts/quickstart.sh
```

Open **http://localhost:50701**. The API health endpoint is
**http://localhost:50700/api/health**.

### First use

1. Create your account in the web application.
2. Create a category or folder and add or import a document.
3. Wait for the document pipeline to finish chunking and embedding.
4. Search using an exact phrase, a related concept, an alternate language, or
   a misspelling.
5. Open **Settings → API** when you want to connect a CLI, MCP client, or
   external application.

The canonical local ports are:

| Service              |    Port |
| -------------------- | ------: |
| Web application      | `50701` |
| REST API             | `50700` |
| PostgreSQL           |  `5437` |
| Redis                |  `6384` |
| SeaweedFS S3 gateway | `50702` |
| SeaweedFS filer UI   | `50703` |

See [Deployment](docs/DEPLOYMENT.md) for domains, TLS, provider tuning,
backups, and production operation.

## Use DocsMint from the terminal

The published package includes the CLI. It connects to an already running
DocsMint server; installing it does not deploy the server.

```bash
npm install @hiai-gg/docsmint
```

```bash
bunx --package @hiai-gg/docsmint docsmint init \
  --url http://localhost:50700 \
  --key 'your-global-or-category-key'

bunx --package @hiai-gg/docsmint docsmint search "project architecture"
bunx --package @hiai-gg/docsmint docsmint list
bunx --package @hiai-gg/docsmint docsmint read <document-id>
bunx --package @hiai-gg/docsmint docsmint create \
  --title "Release notes" --content "# Version 0.2.9"
```

Credentials can also be supplied through `HIAI_DOCS_URL` and
`HIAI_DOCS_API_KEY`. See the [CLI guide](packages/cli/README.md) for every
command and configuration precedence.

## Connect an MCP client

DocsMint exposes document search, reading, creation, updates, categories,
folders, tags, GraphRAG traversal, index status and refresh, snapshots,
history, and export as MCP tools. It also publishes reusable prompts,
context resources, and a document-manager skill for agent clients.

```json
{
  "mcpServers": {
    "docsmint": {
      "command": "bunx",
      "args": ["--package", "@hiai-gg/docsmint", "docsmint-mcp"],
      "env": {
        "HIAI_DOCS_URL": "http://localhost:50700",
        "HIAI_DOCS_API_KEY": "your-global-or-category-key"
      }
    }
  }
}
```

Run the server directly to verify the installation:

```bash
bunx --package @hiai-gg/docsmint docsmint-mcp
```

The server uses stdio and works with MCP-capable clients such as Claude
Desktop, Cursor, and coding agents that accept standard MCP configuration. See
the [MCP guide](packages/mcp-server/README.md) for its 17 tools, prompts,
resources, skill, and API routes.

## Agent skills after installation

The MCP tools are the recommended portable agent skills. A category-bound agent
can receive only the knowledge and operations it needs; a trusted personal
agent can use a global key. Agents do not need database or filesystem access.
After startup, create an API key in **Settings → API** and add the MCP block
above to the agent client. For custom agent workflows, use the same key through
the CLI, SDK, or REST API.

## TypeScript SDK

```bash
bun add @hiai-gg/docsmint
```

```ts
import { DocsClient } from '@hiai-gg/docsmint';

const docs = new DocsClient({
  baseUrl: 'http://localhost:50700',
  apiKey: process.env.HIAI_DOCS_API_KEY,
});

const created = await docs.createDoc({
  title: 'Meeting notes',
  content: '# Agenda',
});

const results = await docs.search('what did we decide?');
console.log(created.id, results.items);
```

The SDK is a typed `fetch` client with retries for transient failures. See the
[SDK reference](packages/sdk/README.md) and [REST API](docs/API.md).

## API keys and integrations

Create and revoke integration keys from **Settings → API**.

| Credential     | Intended use                                 | Access                                 |
| -------------- | -------------------------------------------- | -------------------------------------- |
| Global API key | Trusted owner-wide CLI, MCP, SDK, or service | All owner content                      |
| Category key   | Least-privilege agent or product integration | One category with selected permissions |
| Operator key   | Administration and reindex operations        | `/api/admin/*` only                    |

Category permissions are explicit and non-hierarchical:

- `read` permits list, read, search, and export;
- `edit` permits updates to existing content, attachments, and versions;
- `write` permits create, move, delete, share, and publish operations.

Combine permissions when an integration needs more than one capability.
API-key lifecycle operations require the owning browser session; an API key
cannot create or elevate another key. Server-to-server integrations are not
affected by browser CORS. Browser integrations must add their exact origin to
`CORS_ORIGINS`.

## What is included?

```text
frontend/          SvelteKit workspace and TipTap editor
backend/           Elysia REST API, search, workers, and authentication
packages/db/       Drizzle schema and migrations
packages/sdk/      Typed API client
packages/cli/      Terminal client
packages/mcp-server/  MCP stdio server
postgres/          PostgreSQL image with vector and graph extensions
```

The Docker deployment runs:

- **Web** — document editor, folders, categories, sharing, settings, and search;
- **API** — documents, attachments, versions, keys, search, and administration;
- **PostgreSQL 18** — relational data, pgvector/pgvectorscale vectors, and the
  Apache AGE graph in one database;
- **Redis 8** — BullMQ queues, caching, retries, and job recovery;
- **SeaweedFS** — S3-compatible attachment storage.

## How search works

Every document save schedules background work. Content is chunked, changed
chunks are embedded, and the completed generation is activated atomically. The
previous valid generation remains searchable if a provider call fails.

Search combines exact title matches, multilingual lexical search, typo-tolerant
fuzzy matching, semantic vectors, adaptive query expansion, and Apache AGE
graph neighbors. Reciprocal rank fusion combines the channels without allowing
one weak provider result to dominate. Authorization is applied before retrieval
and again before results are returned.

GraphRAG is part of the normal search path in the reference configuration. It
extracts entities after embeddings are ready and finds related documents beyond
direct keyword or vector similarity. It degrades gracefully when an external
model is unavailable.

For pipeline internals and tuning, see [Architecture](docs/ARCHITECTURE.md) and
[Deployment](docs/DEPLOYMENT.md).

## Stack

- Bun, TypeScript, Elysia, Zod, and Pino
- Svelte 5, SvelteKit, Tailwind CSS, and TipTap
- Better Auth and Drizzle ORM
- PostgreSQL 18, pgvector, pgvectorscale, and Apache AGE
- Redis 8 and BullMQ
- SeaweedFS with its S3-compatible API
- OpenAI-compatible providers through OpenRouter or local Ollama

## Comparison

DocsMint overlaps with several excellent open-source knowledge tools, but its
focus is a compact knowledge runtime shared equally by humans and agents.

| Project                                                      | Primary strength                             | Difference from DocsMint                                                               |
| ------------------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| [Outline](https://github.com/outline/outline)                | Polished team wiki and collaboration         | DocsMint emphasizes built-in retrieval, GraphRAG, scoped agent access, CLI, and MCP    |
| [Docmost](https://github.com/docmost/docmost)                | Collaborative wiki and real-time editing     | DocsMint centers automatic embeddings and agent-facing integration surfaces            |
| [AppFlowy](https://github.com/AppFlowy-IO/AppFlowy)          | Broad local-first productivity workspace     | DocsMint is narrower: a self-hosted document and retrieval service                     |
| [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) | Chat-oriented RAG over imported sources      | DocsMint starts with the editable knowledge base and exposes it to many clients        |
| [Danswer](https://github.com/danswer-ai/danswer) / Onyx      | Enterprise search across external connectors | DocsMint owns and edits its native corpus rather than primarily indexing other systems |

This is a product-positioning summary, not a claim that every listed project
lacks a feature. Check each project's current documentation when choosing a
deployment.

## Documentation

- [Documentation index](docs/README.md)
- [Product usage](docs/USAGE.md)
- [REST API](docs/API.md) and [OpenAPI JSON](docs/openapi.json)
- [Architecture](docs/ARCHITECTURE.md)
- [Deployment and operations](docs/DEPLOYMENT.md)
- [Extension points](docs/EXTENDING.md)
- [Maintainer release flow](docs/RELEASING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## Development

```bash
bun install
bun run lint
bun run typecheck
bun run test
bun run build
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Please
report vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.

## License

DocsMint is released under the [Apache License 2.0](LICENSE).

Built as an independent open-source project in the
[HiAi](https://github.com/HiAi-gg) ecosystem.
