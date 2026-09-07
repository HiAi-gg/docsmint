# DocsMint

**Turn your documents into knowledge you and your AI agents can use.**

Write and organize notes, guides, and project documentation in one workspace.
Find answers with search that understands related concepts, then give your
agents access to the same documents through MCP, REST, the SDK, or CLI.

**[Try managed DocsMint](https://docsmint.com)** to get started without
operating the stack, or **[self-host with Docker](#quickstart)** to run the
Apache-2.0 application on your own infrastructure.

[![Apache-2.0 License](https://img.shields.io/badge/License-Apache--2.0-green.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/hiai-gg/docsmint?sort=semver)](https://github.com/hiai-gg/docsmint/releases)
[![npm](https://img.shields.io/npm/v/@hiai-gg/docsmint?logo=npm)](https://www.npmjs.com/package/@hiai-gg/docsmint)
[![Docker Pulls](https://img.shields.io/docker/pulls/vgalibov/docsmint?logo=docker)](https://hub.docker.com/r/vgalibov/docsmint)
[![Stars](https://img.shields.io/github/stars/hiai-gg/docsmint)](https://github.com/hiai-gg/docsmint/stargazers)
[![CI](https://github.com/hiai-gg/docsmint/actions/workflows/ci.yml/badge.svg)](https://github.com/hiai-gg/docsmint/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/Runtime-Bun_1.4-black?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Svelte](https://img.shields.io/badge/Svelte-5.x-FF3E00?logo=svelte&logoColor=white)](https://svelte.dev)
[![Elysia](https://img.shields.io/badge/Elysia-1.4-lightgrey?logo=elysia&logoColor=white)](https://elysiajs.com)
[![Tailwind_CSS](https://img.shields.io/badge/Tailwind_CSS-v4-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Drizzle_ORM](https://img.shields.io/badge/Drizzle_ORM-0.45-C5F74F?logo=drizzle&logoColor=black)](https://orm.drizzle.team)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![MCP Badge](https://lobehub.com/badge/mcp/hiai-gg-docsmint)](https://lobehub.com/mcp/hiai-gg-docsmint)

[GitHub](https://github.com/HiAi-gg/docsmint) ·
[Docker Hub](https://hub.docker.com/r/vgalibov/docsmint) ·
[npm](https://www.npmjs.com/package/@hiai-gg/docsmint) ·
[LobeHub MCP](https://lobehub.com/mcp/hiai-gg-docsmint)

<img width="1920" height="974" alt="DocsMint installable document workspace" src="https://github.com/user-attachments/assets/94701d01-a361-4ca1-b16d-de2a0c64d684" />

## Why DocsMint?

- **Keep knowledge easy to edit.** Use a rich visual editor or Markdown;
  organize documents with folders, categories, and tags.
- **Find the document you mean.** Search combines keywords, meaning, typo
  tolerance, and graph relationships across languages.
- **Keep agents close to the source.** Let your tools search, read, and update
  the same knowledge through MCP, REST, a typed SDK, and CLI.
- **Choose what an integration can access.** Category keys grant explicit
  `read`, `edit`, and `write` permissions for a defined part of your library.
- **Keep retrieval up to date.** Document edits and metadata changes refresh
  the search index automatically in the background.
- **Choose how you run it.** Use [managed DocsMint](https://docsmint.com) or
  self-host the application, database, search, queues, and files.

## What's new in 0.8.3?

This maintenance release focuses on reliable saves and integrations:

- Pending editor saves stay attached to the document being edited, even when
  you switch documents.
- Navigation waits for pending content saves; overlapping saves are serialized
  so an older request cannot overwrite a newer edit.
- SDK document creation retries reuse an idempotency key to prevent duplicates
  after a lost response.
- Workspace-wide tag management requires full write access; read-only and
  category-scoped credentials can no longer mutate the entire tag collection.
- Partial category API-setting updates preserve omitted permissions.
- Public workspace share links retain their workspace context when loading
  folders and documents.

No schema migration is added. Existing public request and response shapes
remain supported; the tag authorization fix intentionally rejects operations
that exceeded the caller's permissions.

Read the complete release history in the [changelog](CHANGELOG.md) or
[GitHub Releases](https://github.com/HiAi-gg/docsmint/releases). See the
[roadmap](docs/ROADMAP.md) for what comes next.

## Install with an AI agent

Prefer an assisted self-hosted setup? Give your coding agent this prompt.
You will need Docker and a choice of AI provider.

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

Published application images are on
[Docker Hub](https://hub.docker.com/r/vgalibov/docsmint). There is no untagged
`latest` image; pull the role-specific tags:

```bash
docker pull vgalibov/docsmint:api-latest
docker pull vgalibov/docsmint:web-latest
docker pull vgalibov/docsmint:caddy-latest
```

Use versioned tags `api-v0.8.3`, `web-v0.8.3`, and `caddy-v0.8.3` for
reproducible deploys. The quickstart still builds the Compose stack from this repository so PostgreSQL,
Redis, and SeaweedFS start together with the application.

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

Embedding provider URLs, models, and credentials are deployment configuration.
They are never stored in browser settings or local storage.

## Use DocsMint from the terminal

The published package includes the CLI. It connects to an already running
DocsMint server; installing it does not deploy the server.

```bash
bun add @hiai-gg/docsmint
```

```bash
bunx --package @hiai-gg/docsmint docsmint init \
  --url http://localhost:50700 \
  --key 'your-global-or-category-key'

bunx --package @hiai-gg/docsmint docsmint search "project architecture"
bunx --package @hiai-gg/docsmint docsmint list
bunx --package @hiai-gg/docsmint docsmint read <document-id>
bunx --package @hiai-gg/docsmint docsmint create \
  --title "Release notes" --content "# Highlights"
```

Credentials can also be supplied through `HIAI_DOCS_URL` and
`HIAI_DOCS_API_KEY`. See the [CLI guide](packages/cli/README.md) for every
command and configuration precedence.

## Connect an MCP client

Give agents a secure path to search, read, and maintain your knowledge without
database or filesystem access. DocsMint publishes 17 tools plus ready-made
research prompts, scoped resources, and a document-manager skill.

### Hosted DocsMint

Connect directly to the managed Streamable HTTP endpoint. Keep the API key in
an environment variable rather than writing it into client configuration:

```bash
codex mcp add docsmint \
  --url https://docsmint.com/mcp \
  --bearer-token-env-var HIAI_DOCS_API_KEY
```

### Self-hosted DocsMint

Run the published stdio bridge against your own DocsMint API:

```json
{
  "mcpServers": {
    "docsmint": {
      "command": "npx",
      "args": ["-y", "@hiai-gg/docsmint", "docsmint-mcp"],
      "env": {
        "HIAI_DOCS_URL": "http://localhost:50700",
        "HIAI_DOCS_API_KEY": "your-global-or-category-key"
      }
    }
  }
}
```

Category keys let you expose only the documents and operations an agent needs.
Use a global key only for trusted owner-wide automation. See the
[complete MCP reference](packages/mcp-server/README.md) for Bun, npm, local
checkout, all tools, prompts, resources, permissions, and REST mappings.

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

The SDK is a typed `fetch` client with retries for transient failures and
idempotent document creation retries. See the
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

Documents use structured TipTap JSON as canonical content. Markdown is the
source-editing, import, and export format. The same document store serves the
web application and public integration interfaces.

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
one weak provider result to dominate. A cross-encoder then reranks the fused
prefix against the original query (Voyage rerank-2.5 by default). On a labeled
24-document corpus that moved MRR 0.969 → 1.000 and nDCG@10 0.958 → 0.986
versus RRF-only. Rerank, expansion, embeddings, and AGE failures keep the
remaining channels. Authorization is applied before retrieval and again before
results are returned.

GraphRAG is part of the normal search path in the reference configuration. It
extracts entities after embeddings are ready and finds related documents beyond
direct keyword or vector similarity. It degrades gracefully when an external
model is unavailable.

For pipeline internals and tuning, see [Architecture](docs/ARCHITECTURE.md) and
[Deployment](docs/DEPLOYMENT.md).

## Stack

- Bun 1.4.0+, TypeScript, Elysia, Zod, and Pino
- Svelte 5, SvelteKit, Tailwind CSS, and TipTap
- Better Auth and Drizzle ORM
- PostgreSQL 18, pgvector, pgvectorscale, and Apache AGE
- Redis 8 and BullMQ
- SeaweedFS with its S3-compatible API
- OpenAI-compatible providers through OpenRouter or local Ollama

## Documentation

- [Documentation index](docs/README.md)
- [Product usage](docs/USAGE.md)
- [Roadmap](docs/ROADMAP.md)
- [REST API](docs/API.md) and [OpenAPI JSON](docs/openapi.json)
- [Architecture](docs/ARCHITECTURE.md)
- [Deployment and operations](docs/DEPLOYMENT.md)
- [Extension points](docs/EXTENDING.md)
- [Maintainer release flow](docs/RELEASING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## Development

Use Bun 1.4.0 or later for local development.

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
