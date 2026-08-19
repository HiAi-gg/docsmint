# DocsMint MCP server

Stdio Model Context Protocol server for a running [DocsMint](https://github.com/HiAi-gg/docsmint) instance.

## Installation

### Bunx

```bash
bunx --package @hiai-gg/docsmint docsmint-mcp
```

### NPX

```bash
npx --yes --package @hiai-gg/docsmint docsmint-mcp
```

### Local checkout

```bash
git clone https://github.com/HiAi-gg/docsmint.git
cd docsmint
bun install --frozen-lockfile
bun run packages/mcp-server/src/index.ts
```

The MCP binary is shipped by `@hiai-gg/docsmint`; `@hiai-gg/docsmint-mcp` is not the package name. All three methods run the same stdio server.

## Client configuration

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

`HIAI_DOCS_URL` defaults to `http://localhost:50700`. The optional API key is sent as a Bearer token. Prefer a category key for a category-bound agent and a global key for trusted owner-wide automation. Category `read`, `edit`, and `write` scopes are explicit rather than hierarchical; configure the combination required by the tools you expose.

## Tools and REST routes

| MCP tool | REST route |
|---|---|
| `search_documents` | `GET /api/search` |
| `get_document` | `GET /api/documents/:id` |
| `create_document` | `POST /api/documents` |
| `update_document` | `PATCH /api/documents/:id` |
| `list_documents` | `GET /api/documents` |
| `list_folders` | `GET /api/folders` |
| `create_folder` | `POST /api/folders` |
| `create_snapshot` | `POST /api/documents/:id/versions` |
| `get_version_history` | `GET /api/documents/:id/versions` |
| `export_document` | `GET /api/documents/:id/export` |
| `list_categories` | `GET /api/categories` |
| `create_category` | `POST /api/categories` |
| `list_tags` | `GET /api/tags` |
| `get_related_documents` | `GET /api/graph/related/:id` |
| `search_knowledge_graph` | `POST /api/graph/search` |
| `get_document_index_status` | `GET /api/documents/:id/index-status` |
| `refresh_document_index` | `POST /api/documents/:id/index/refresh` |

## Prompts and resources

The server exposes `organize_workspace` and `research_workspace` prompts. MCP clients can also attach the editor rules, retrieval rules, and the live scoped workspace catalog through these resources:

- `docsmint://guide/editor`
- `docsmint://guide/search`
- `docsmint://workspace/catalog`

The repository ships the reusable [`docsmint-document-manager` skill](../../skills/docsmint-document-manager/SKILL.md). It documents the same workspace/category permissions, multilingual retrieval flow, editor rules, and indexing lifecycle used by the API and UI.

Workspace keys can manage the complete document domain allowed by their live workspace role. Category keys are restricted to their bound category, its folders and documents, and their explicit `read`, `edit`, and `write` permissions. Category keys cannot create categories or escape their category through document, folder, graph, tag, or index operations.

The server does not manage or reveal keys; those endpoints require a Better Auth browser session. MCP errors preserve the backend HTTP status and message without exposing credentials.

## Development

```bash
cd packages/mcp-server
bun run test
bun run typecheck
bun run dev
```
