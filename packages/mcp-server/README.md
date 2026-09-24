# DocsMint MCP server

Give your AI agents persistent project knowledge. Search, read, create, and
organize documents with hybrid retrieval, reranking, GraphRAG, and scoped access.

**DocsMint Cloud is recommended:** connect to `https://docsmint.com/mcp` over
Streamable HTTP. No server deployment is required. For an advanced self-hosted
setup, run your own DocsMint API and connect the `docsmint-mcp` stdio bridge with
your own API key. The bridge ships in **`@hiai-gg/docsmint`** alongside the
TypeScript SDK and CLI.

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
`401` with a `WWW-Authenticate` link to
`/.well-known/oauth-protected-resource/mcp`. That resource metadata points to
`/.well-known/oauth-authorization-server`. The current hosted authorization and
client-connection methods are described in the
[DocsMint Cloud setup guide](https://docsmint.com/mcp/connect).

Current authorization metadata advertises the `code` response type, only the
`authorization_code` grant, no token-endpoint client authentication, and PKCE
with `S256`. The token endpoint exchanges an authorization code and does not
issue or accept refresh tokens.

Authorization uses your existing DocsMint account and browser consent with the
authorization-code grant and required PKCE S256. Consent binds access to the
selected workspace, optional category, and requested `mcp:read`, `mcp:edit`, and
`mcp:write` scopes. Opaque bearer tokens are bound to the hosted MCP resource,
expire after one hour, and can be revoked in the browser UI. No refresh tokens are
issued; authorize again after expiry. This is a DocsMint Cloud feature, not an
OAuth server installed by the stdio npm bridge.

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
The bridge authenticates to your own DocsMint API with that Bearer API key; it does
not install or expose the DocsMint Cloud OAuth authorization server.

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

### Tools

- `search_documents`: Retrieve readable documents with hybrid full-text and semantic search; optional tags are tag names. Use graph tools for graph-only exploration.
- `get_document`: Read one document with editable content and metadata; use `export_document` when only portable Markdown is needed.
- `create_document`: Create new content with optional title, Markdown, and placement; requires write access, schedules normal indexing, and defaults an omitted title to “Untitled”. Category-scoped credentials must stay in their configured category. Use `update_document` for an existing document.
- `update_document`: Patch an existing document after reading it; omitted fields stay unchanged, `null` clears folder/category placement, prior content is retained in version history, and changed content or placement queues indexing. Use `create_document` for new content.
- `list_documents`: Page through readable documents and optionally filter by folder UUID or tag UUID; use `search_documents` for text or semantic retrieval.
- `list_folders`: List root folders or the immediate children of a folder in the active scope.
- `create_folder`: Create a root or nested folder; nested folders inherit their parent's category, and a category-scoped credential stays inside its configured category.
- `create_snapshot`: Save a named snapshot of current content without changing the document; use its returned version ID with `restore_document_version`.
- `get_version_history`: Read auto-saved revisions and snapshots; use `restore_document_version` to restore a selected version.
- `export_document`: Render a readable document as portable Markdown without the full metadata returned by `get_document`.
- `list_categories`: List categories visible in the active workspace or category scope.
- `create_category`: Create a category with workspace-level write access; category-scoped credentials cannot create categories.
- `list_tags`: List visible tags with both IDs (for `list_documents`) and names (for `search_documents`).
- `get_related_documents`: Traverse graph neighbors from one readable document without a text query; use `search_knowledge_graph` to filter/rank neighbors with query text.
- `search_knowledge_graph`: Search graph relations from readable seed document IDs; use `search_documents` for normal hybrid retrieval.
- `get_document_index_status`: Inspect indexing state without starting work; use `refresh_document_index` only when a retry is intended.
- `refresh_document_index`: Queue an explicit asynchronous reindex for a readable document after checking status; routine content or placement changes already schedule indexing as needed.

- `delete_document`: Move a writable document to trash; no permanent purge.
- `delete_folder`: Delete a writable folder while preserving its documents.
- `delete_category`: Delete a category using full workspace write access; category keys are denied.
- `restore_document_version`: Restore content from a version or snapshot with edit access; `get_version_history` lists eligible version IDs. Current content is backed up first, and indexing is queued.

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

### Prompts

- `organize_workspace`: Plan safe document organization using DocsMint categories and folders.
- `research_workspace`: Research a question with hybrid search, GraphRAG, and rerank citing document IDs.

### Resources

- `docsmint://guide/editor`: Editor usage guide.
- `docsmint://guide/search`: Search, GraphRAG, and rerank guide.
- `docsmint://workspace/catalog`: Live scoped workspace catalog.

### Skills

- [`docsmint-document-manager`](https://github.com/HiAi-gg/docsmint/blob/main/skills/docsmint-document-manager/SKILL.md):
  create, organize, edit, and research DocsMint documents through DocsMint's MCP
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
