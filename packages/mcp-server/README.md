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

### Glama Server listing

For the [Glama MCP Server directory](https://glama.ai/mcp/servers), submit this
open-source stdio bridge from the [DocsMint repository](https://github.com/HiAi-gg/docsmint).
Start it with the NPX command above (Bun must be installed to execute the published
binary). Provide `HIAI_DOCS_URL` as the URL of an already running, reachable
DocsMint API and `HIAI_DOCS_API_KEY` as a secret API key with the permissions
your tools need. Both values are required for a usable hosted Glama process:
the default `localhost` URL refers to Glama's own environment, not your API.
The process can advertise tools, prompts, and resources without API access,
but document operations need a reachable API and a valid key. Glama's
[hosted Connector](https://glama.ai/mcp/connectors/io.github.HiAi-gg/docsmint)
uses DocsMint Cloud at `https://docsmint.com/mcp` and is a separate listing.

## MCP Features

### Tools

DocsMint exposes 20 MCP tools. The former 31 operations are still available;
grouped tools require an explicit `mode`, `view`, `kind`, or `action` so an agent
cannot confuse browsing with search, restoring a version with restoring trash,
or a reversible delete with permanent purge. No second or legacy tool catalog is
advertised. Use a matching version of the self-hosted bridge or Cloud endpoint
when migrating an MCP client that invokes the old tool names.

- `find_documents`: Browse by folder/tag UUID with `mode=list`, or hybrid-search by text/tag names with `mode=search`.
- `read_document`: Read content and metadata with `view=detail`, export Markdown with `view=markdown`, or list revisions and snapshots with `view=versions`.
- `save_document`: Create a document with `action=create` or patch an existing one with `action=update`. Omitted patch fields remain unchanged; null placement clears it. The API enforces the effective category and schedules indexing.
- `delete_document`: Move a document to trash without purging its content or versions.
- `list_workspace_structure`: List folders, categories, or tags with `kind=folders|categories|tags`; folders optionally accept `parentId`.
- `save_folder`: Create with `action=create` or rename, move, or reorder with `action=update`; metadata changes queue reindexing.
- `delete_folder`: Remove a folder while preserving its documents under the API's detachment rules.
- `save_category`: Create with `action=create` or rename/reorder with `action=update`; requires full workspace write access.
- `delete_category`: Remove a category and detach its documents; requires full workspace write access.
- `save_tag`: Create with `action=create` or rename/recolor with `action=update`; requires full workspace write access.
- `delete_tag`: Delete a tag and its assignments without deleting documents.
- `set_document_tag`: Assign with `action=add` or unassign with `action=remove`; requires edit access to the document.
- `create_snapshot`: Save a named version of the current document content.
- `restore_document_version`: Restore content from a revision or snapshot selected through `read_document(view=versions)`; pass that document's UUID as `documentId`.
- `explore_graph`: Traverse one document with `mode=neighbors` or rank relations from seed IDs with `mode=search`.
- `get_document_index_status`: Inspect indexing state without starting work.
- `refresh_document_index`: Queue an explicit asynchronous retry after checking status.
- `list_trash`: List soft-deleted documents visible in the active scope.
- `restore_trashed_document`: Recover a soft-deleted document; this does not restore an older version.
- `permanently_delete_document`: Irreversibly purge a document already in trash on explicit user request.

Grouped tools return `{ "operation": "<selected variant>", "result": ... }` in both
text and structured MCP content. Other tools preserve their prior result shapes.
The 31-to-20 migration is:

| Previous tools | Current tool and selector |
|---|---|
| `search_documents`, `list_documents` | `find_documents` with `mode=search|list` |
| `get_document`, `export_document`, `get_version_history` | `read_document` with `view=detail|markdown|versions` |
| `create_document`, `update_document` | `save_document` with `action=create|update` |
| `list_folders`, `list_categories`, `list_tags` | `list_workspace_structure` with `kind=folders|categories|tags` |
| `create_folder`, `update_folder` | `save_folder` with `action=create|update` |
| `create_category`, `update_category` | `save_category` with `action=create|update` |
| `create_tag`, `update_tag` | `save_tag` with `action=create|update` |
| `add_tag_to_document`, `remove_tag_from_document` | `set_document_tag` with `action=add|remove` |
| `get_related_documents`, `search_knowledge_graph` | `explore_graph` with `mode=neighbors|search` |
| `delete_document`, `delete_folder`, `delete_category`, `delete_tag`, `create_snapshot`, `restore_document_version`, `get_document_index_status`, `refresh_document_index`, `list_trash`, `restore_trashed_document`, `permanently_delete_document` | Same names and behavior |

### Lifecycle permissions

| Operation | Required permission | Effect |
|---|---|---|
| Delete document | `write` in its effective category | Soft-delete to trash; content and version history remain stored. |
| Delete folder | `write` in its effective category | Remove folder; direct child folders and documents are detached, not deleted. |
| Delete category | Full workspace `write` | Detach category membership; preserve content and queue reindexing. Category keys cannot do this. |
| Restore version | `edit` on the document | Back up current content, restore selected version content, queue indexing. Does not change title or placement. |
| Create, update, or delete tag | Full workspace `write` | Manage the workspace tag catalog; category keys cannot do this. |
| Assign or remove document tag | `edit` on the document | Change one document's tag membership and queue metadata reindexing. |
| Update folder | `write` in its effective category | Rename or move a folder within the API's scope rules; queue metadata reindexing. |
| Update category | Full workspace `write` | Rename or reorder a category; category keys cannot do this. |
| List trash | `read` in the active scope | Show soft-deleted documents visible to the key. |
| Restore trashed document | `write` in its effective category | Return a soft-deleted document to the active library. |
| Permanently delete document | `write` in its effective category | Irreversibly purge a document already in trash, including version history. |

Use UUIDs returned by the listing/history tools. A snapshot is a version with a label:
pass its version ID to `restore_document_version`. Use `restore_trashed_document`
to recover a trashed document. Lifecycle tools advertise destructive annotations; authorization
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

The grouped selectors map to the same documented REST operations; the stdio
bridge has no database or auth-server implementation of its own. See the
[machine-readable REST contract](../../docs/openapi.json) and the operation
mapping above for endpoint details.

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
