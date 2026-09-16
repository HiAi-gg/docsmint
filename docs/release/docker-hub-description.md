# DocsMint

**Turn your documents into knowledge you and your AI agents can use.**

Write and organize project knowledge, find documents by wording and meaning,
and connect your AI tools to the same workspace through MCP, REST, SDK, and CLI.
Self-host DocsMint with Docker Compose under the Apache-2.0 license.

[Get started](https://github.com/HiAi-gg/docsmint#quickstart) ·
[Documentation](https://github.com/HiAi-gg/docsmint/tree/main/docs) ·
[Release notes](https://github.com/HiAi-gg/docsmint/releases) ·
[Try DocsMint Cloud](https://docsmint.com)

## Start your workspace

Install Docker Engine or Docker Desktop with Docker Compose v2. Choose an
OpenRouter API key or a local Ollama instance for AI features, then run:

```bash
git clone https://github.com/HiAi-gg/docsmint.git
cd docsmint
bash scripts/quickstart.sh
```

Follow the provider setup prompts. Open **http://localhost:50701** after startup.
See the [quickstart guide](https://github.com/HiAi-gg/docsmint#quickstart) for
configuration and [deployment guide](https://github.com/HiAi-gg/docsmint/blob/main/docs/DEPLOYMENT.md)
for production operation.

## Choose the right image

DocsMint is a multi-service application. This repository contains three service
images; a single `docker run` command does not install the complete workspace.

| Service | Versioned tag | Moving tag | Purpose |
| --- | --- | --- | --- |
| API | `api-v0.8.5` | `api-latest` | Backend API and document processing |
| Web | `web-v0.8.5` | `web-latest` | Browser workspace |
| Caddy | `caddy-v0.8.5` | `caddy-latest` | Supporting reverse proxy with rate limiting |

**There is no bare `latest` tag.** Specify the service when pulling an image:

```bash
docker pull vgalibov/docsmint:api-v0.8.5
docker pull vgalibov/docsmint:web-v0.8.5
docker pull vgalibov/docsmint:caddy-v0.8.5
```

Caddy is the proxy component, not the DocsMint editor or API. Select `web-v0.8.5` for the browser workspace and `api-v0.8.5` for its backend.

The 0.8.5 images are published for **Linux amd64**. Use matching versioned tags
for all three components; pin image digests when immutable references are needed.
The quickstart builds the repository's Compose stack, including its supporting
PostgreSQL, Redis, and SeaweedFS services.

## What you can do

- **Write and organize:** rich document editing, Markdown, folders, categories,
  tags, sharing, and version history.
- **Find useful context:** keyword, fuzzy, and semantic retrieval, reranking,
  and GraphRAG with configured AI providers.
- **Connect agents:** search, read, and update persistent knowledge through
  MCP and documented application interfaces.
- **Control access:** give integrations explicit permissions for the knowledge
  they need.
- **Choose your deployment:** operate the stack yourself or
  [connect DocsMint Cloud](https://docsmint.com/mcp/connect?source=dockerhub).

Self-hosting puts application data and storage on your infrastructure. AI
requests go to the providers you configure; choose local inference when needed.

## Project links

- [Source and license](https://github.com/HiAi-gg/docsmint)
- [Releases and upgrade notes](https://github.com/HiAi-gg/docsmint/releases)
- [SDK, CLI, and MCP npm package](https://www.npmjs.com/package/@hiai-gg/docsmint)
- [MCP connection guide](https://github.com/HiAi-gg/docsmint/blob/main/packages/mcp-server/README.md)
- [Report an issue](https://github.com/HiAi-gg/docsmint/issues)
