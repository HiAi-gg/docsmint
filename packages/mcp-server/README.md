# DocsMint MCP server

Give your AI agents persistent project knowledge. Search, read, create, and
organize documents with hybrid retrieval, reranking, GraphRAG, and scoped access.

Connect to DocsMint Cloud over HTTP, or use the `docsmint-mcp` stdio bridge with
your self-hosted deployment. The bridge ships in **`@hiai-gg/docsmint`** alongside
the TypeScript SDK and CLI.

## Option A — DocsMint Cloud (recommended)

Start at [Connect DocsMint Cloud](https://docsmint.com/mcp/connect?source=npm_mcp).
No self-hosted server or local MCP process is required.

1. Sign up or log in to your existing DocsMint account.
2. Choose your workspace and confirm your plan includes hosted MCP.
3. For OAuth-capable clients, authorize in the browser and consent to your
   workspace and explicit scopes. For API-key clients, create an MCP/API credential
   in the authenticated UI; prefer workspace-bound or category-scoped access.
4. Select your MCP client and follow its connection instructions.
5. Verify the connection with initialize and a permitted tool call.

OAuth-capable clients use the same hosted URL. An unauthenticated request returns
`401` with a `WWW-Authenticate` discovery link. Authorization uses your existing
DocsMint account, browser consent and authorization code with PKCE S256. Tokens
are bound to the hosted resource, expire after one hour and can be revoked in the
browser UI. No refresh tokens are issued; authorize again after expiry. This is a
DocsMint Cloud feature, not an OAuth server installed by the stdio npm bridge.

API-key clients connect to `https://docsmint.com/mcp` using
`Authorization: Bearer <key>`. Credential creation, changes, and revocation are
browser-session-owned: MCP/API credentials cannot create or elevate credentials.

```bash
export HIAI_DOCS_API_KEY="your-global-or-category-key"

codex mcp add docsmint \
  --url https://docsmint.com/mcp \
  --bearer-token-env-var HIAI_DOCS_API_KEY
```

Generic HTTP clients should connect to `https://docsmint.com/mcp` with
`Authorization: Bearer <key>`. Bound workspace keys need no extra header;
unbound keys can supply the documented `X-Docsmint-Workspace` slug.

## Option B — Self-hosted stdio bridge (advanced)

The published MCP binary connects to an already running DocsMint API. Installing
the package does not deploy DocsMint itself.

Run DocsMint first, create an API key in its authenticated browser UI, set
`HIAI_DOCS_URL` to your deployment API URL and `HIAI_DOCS_API_KEY` to that key,
then start the stdio bridge. Do not use an `/api/health` URL as an MCP endpoint.

### Run with Bun

```bash
bunx --package @hiai-gg/docsmint docsmint-mcp
```

### Run with NPX

```bash
npx --yes --package @hiai-gg/docsmint docsmint-mcp
```

### Run from a local checkout

```bash
git clone https://github.com/HiAi-gg/docsmint.git
cd docsmint
bun install --frozen-lockfile
bun run packages/mcp-server/src/index.ts
```

All three methods run the same stdio server from `@hiai-gg/docsmint`.

### Client configuration

```json
{
  "mcpServers": {
    "docsmint": {
      "command": "npx",
      "args": ["--yes", "--package", "@hiai-gg/docsmint", "docsmint-mcp"],
      "env": {
        "HIAI_DOCS_URL": "http://localhost:50700",
        "HIAI_DOCS_API_KEY": "your-global-or-category-key"
      }
    }
  }
}
```

`HIAI_DOCS_URL` defaults to `http://localhost:50700`. The optional API key is sent as a Bearer token. Prefer a category key for a category-bound agent and a global key for trusted owner-wide automation. Category `read`, `edit`, and `write` scopes are explicit rather than hierarchical; configure the combination required by the tools you expose.

## MCP Features

### Tools (21)

- `search_documents`: Hybrid search (full-text + semantic pgvector).
- `get_document`: Fetch document content and metadata.
- `create_document`: Create a document with optional markdown, folder, and category.
- `update_document`: Update title, content, folder, or category.
- `list_documents`: Paginated document list, optionally filtered by folder or tag.
- `list_folders`: List folders, optionally under a parent.
- `create_folder`: Create a folder, optionally nested.
- `create_snapshot`: Create a named snapshot of the current document.
- `get_version_history`: List versions, optionally snapshots only.
- `export_document`: Export a document as Markdown.
- `list_categories`: List categories visible to the API key.
- `create_category`: Create a category (workspace key with write access).
- `list_tags`: List tags in the workspace or bound category.
- `get_related_documents`: Traverse the knowledge graph from one authorized document.
- `search_knowledge_graph`: Search connected knowledge from authorized seed documents.
- `get_document_index_status`: Read indexing and knowledge-pipeline status.
- `refresh_document_index`: Request reindexing after a document or metadata change.

- `delete_document`: Move a writable document to trash; no permanent purge.
- `delete_folder`: Delete a writable folder while preserving its documents.
- `delete_category`: Delete a category using full workspace write access; category keys are denied.
- `restore_document_version`: Restore document content from a version or snapshot with edit access.

### Lifecycle permissions

| Operation | Required permission | Effect |
|---|---|---|
| Delete document | `write` in its effective category | Soft-delete to trash; content and version history remain stored. |
| Delete folder | `write` in its effective category | Remove folder; direct child folders and documents are detached, not deleted. |
| Delete category | Full workspace `write` | Detach category membership; preserve content and queue reindexing. Category keys cannot do this. |
| Restore version | `edit` on the document | Back up current content, restore selected version content, queue indexing. Does not change title or placement. |

Use UUIDs returned by the listing/history tools. A snapshot is a version with a label:
pass its version ID to `restore_document_version`. Restoration does not recover
trashed documents. Lifecycle tools advertise destructive annotations; authorization
is enforced by the REST API, not by those advisory client hints. Failed requests
return MCP `isError` with the REST status; they never acknowledge a successful deletion.

### Prompts (2)

- `organize_workspace`: Plan safe document organization using DocsMint categories and folders.
- `research_workspace`: Research a question with hybrid search, GraphRAG, and rerank citing document IDs.

### Resources (3)

- `docsmint://guide/editor`: Editor usage guide.
- `docsmint://guide/search`: Search, GraphRAG, and rerank guide.
- `docsmint://workspace/catalog`: Live scoped workspace catalog.

### Skills (1)

- [`docsmint-document-manager`](https://github.com/HiAi-gg/docsmint/blob/main/skills/docsmint-document-manager/SKILL.md):
  create, organize, edit, and research DocsMint documents through the 21 MCP
  tools.

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
| `delete_document` | `DELETE /api/documents/:id` |
| `delete_folder` | `DELETE /api/folders/:id` |
| `delete_category` | `DELETE /api/categories/:id` |
| `restore_document_version` | `POST /api/documents/:id/versions/:versionId/restore` |

## Prompts and resources

The server exposes `organize_workspace` and `research_workspace` prompts. MCP clients can also attach the editor rules, retrieval rules, and the live scoped workspace catalog through these resources:

- `docsmint://guide/editor`
- `docsmint://guide/search`
- `docsmint://workspace/catalog`

The repository ships the reusable [`docsmint-document-manager` skill](https://github.com/HiAi-gg/docsmint/blob/main/skills/docsmint-document-manager/SKILL.md). It documents the same workspace/category permissions, multilingual retrieval flow, editor rules, and indexing lifecycle used by the API and UI.

Workspace keys can manage the complete document domain allowed by their live workspace role. Category keys are restricted to their bound category, its folders and documents, and their explicit `read`, `edit`, and `write` permissions. Category keys cannot create categories or escape their category through document, folder, graph, tag, or index operations.

The server does not manage or reveal keys; those endpoints require a Better Auth browser session. MCP errors preserve the backend HTTP status and message without exposing credentials.

## Development

```bash
cd packages/mcp-server
bun run test
bun run typecheck
bun run dev
```
