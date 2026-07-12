# hiai-docs MCP server

Stdio Model Context Protocol server for a running [hiai-docs](https://github.com/HiAi-gg/hiai-docs) instance.

## Run the published server

```bash
bunx --package @hiai-gg/hiai-docs hiai-docs-mcp
```

The MCP binary is shipped by `@hiai-gg/hiai-docs`; `@hiai-gg/hiai-docs-mcp` is not the package name.

## Client configuration

```json
{
  "mcpServers": {
    "hiai-docs": {
      "command": "bunx",
      "args": ["--package", "@hiai-gg/hiai-docs", "hiai-docs-mcp"],
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

The server does not manage or reveal keys; those endpoints require a Better Auth browser session. MCP errors preserve the backend HTTP status and message without exposing credentials.

## Development

```bash
cd packages/mcp-server
bun run test
bun run typecheck
bun run dev
```
