# API guide
This guide explains the stable integration model and the most common workflows.
The exhaustive, machine-readable endpoint contract is
[`openapi.json`](openapi.json). Use that file when generating clients or when an
endpoint, field, validation limit, or response schema is not shown here.
## Base URL and conventions
The default local API URL is:

```text
http://localhost:50700
```

Requests and responses use JSON unless an endpoint transfers a file. Protected
requests send either a Better Auth session cookie or a Bearer key:

```bash
curl -H "Authorization: Bearer $HIAI_DOCS_API_KEY" \
  http://localhost:50700/api/documents
```

List endpoints normally return:

```json
{ "items": [], "total": 0, "page": 1, "limit": 20 }
```

Errors use this shape:

```json
{ "error": "Human-readable message", "details": {} }
```

| Status | Meaning |
| --- | --- |
| `400` | Invalid request; inspect `details` when present |
| `401` | Authentication is missing or invalid |
| `403` | The principal is authenticated but lacks access |
| `404` | The resource does not exist in the accessible scope |
| `409` | The requested state conflicts with existing data |
| `410` | A share link has expired |
| `413` | Upload exceeds the configured limit |
| `429` | Rate limited; inspect `Retry-After` |
| `500` | Unexpected server error |

Health is public:

```bash
curl -fsS http://localhost:50700/api/health
```
## Authentication and keys
hiai-docs has three separate credential models:

1. **Better Auth session** for the web application and key management.
2. **User API key** for REST, SDK, CLI, MCP, and service integrations.
3. **Static operator key** (`HIAI_DOCS_API_KEY`) for `/api/admin/*` and
   protected metrics. It is not a user-content key.

User API keys use `Authorization: Bearer <key>`. Key lifecycle routes require a
real Better Auth browser session: API keys cannot issue, list, reveal, or revoke
other keys.
### Scope matrix
| Credential or scope | Boundary | Read | Edit | Write |
| --- | --- | :---: | :---: | :---: |
| Better Auth session | All content owned by the user | Yes | Yes | Yes |
| `global` | All content owned by the user | Yes | Yes | Yes |
| `category:<uuid>:read` | Effective category only | Yes | No | No |
| `category:<uuid>:edit` | Effective category only | No | Yes | No |
| `category:<uuid>:write` | Effective category only | No | No | Yes |
| Static operator key | Operator routes only | Yes | Yes | Yes |

Category permissions are explicit and non-hierarchical. Combine scopes when an
integration needs more than one capability. `read` covers retrieval, list,
search, graph, export, attachment download, and version retrieval. `edit` covers
updates to existing content, tags, attachments, snapshots, and restores.
`write` covers create, import, duplicate, delete, placement, folders, shares,
and publish state.

The effective category is the document's explicit category or, when absent,
the category inherited through its folder ancestry. Category keys cannot access
uncategorized or other-category content, and they cannot manage category
definitions. Lists and search results are filtered rather than exposing
forbidden rows.
### Key lifecycle
| Method and path | Purpose |
| --- | --- |
| `POST /api/keys/global` | Create a global key |
| `POST /api/categories/:id/keys` | Create a key from saved category API settings |
| `GET /api/keys` | List owned key metadata |
| `GET /api/keys/:id/secret` | Reveal a recoverable category key |
| `DELETE /api/keys/:id` | Revoke an owned key |

```bash
# These examples require a Better Auth session cookie.
curl -X POST http://localhost:50700/api/keys/global \
  -H 'Content-Type: application/json' \
  -H 'Cookie: better-auth.session_token=…' \
  -d '{"name":"Docsmint server"}'

curl -X POST http://localhost:50700/api/categories/$CATEGORY_ID/keys \
  -H 'Content-Type: application/json' \
  -H 'Cookie: better-auth.session_token=…' \
  -d '{"name":"Docsmint category"}'
```

Before issuing a category key, save the category with `apiMode: "category"`
and at least one of `apiPermissionRead`, `apiPermissionEdit`, or
`apiPermissionWrite`. The server derives the scopes from those settings.

Global secrets are returned once and retained only as hashes. Category secrets
are encrypted at rest and can be revealed by their owning browser session.
Revocation applies to subsequent validation immediately.
## Common REST workflows
All protected examples below assume:

```bash
export HIAI_DOCS_URL=http://localhost:50700
export HIAI_DOCS_API_KEY='…'
```
### Documents and folders
```bash
# List
curl -H "Authorization: Bearer $HIAI_DOCS_API_KEY" \
  "$HIAI_DOCS_URL/api/documents?page=1&limit=20"
# Create
curl -X POST "$HIAI_DOCS_URL/api/documents" \
  -H "Authorization: Bearer $HIAI_DOCS_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Agent note","content":"Important finding"}'
# Update
curl -X PATCH "$HIAI_DOCS_URL/api/documents/$DOCUMENT_ID" \
  -H "Authorization: Bearer $HIAI_DOCS_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Updated note","content":"Revised finding"}'
```

Documents also support delete, duplicate, Markdown export, import, category and
folder placement, tags, visibility, and pipeline status. Folders support nested
create, list, rename, move, and delete. See [`openapi.json`](openapi.json) for
their request schemas.
### Search
```bash
curl -G "$HIAI_DOCS_URL/api/search" \
  -H "Authorization: Bearer $HIAI_DOCS_API_KEY" \
  --data-urlencode 'q=how to deploy docker' \
  --data 'page=1' --data 'limit=20' --data 'includeChunks=true'
```

Search combines exact/title, multilingual lexical, fuzzy, vector, adaptive
expansion, and GraphRAG channels with reciprocal rank fusion. Results are
authorized before retrieval and hydration. Common filters include `folder`,
comma-separated `tags`, `dateFrom`, `dateTo`, and `sort`. Each result includes
safe explanations; `includeChunks=true` adds up to three matching snippets.
Provider prompts, credentials, tenant identifiers, and internal scores are not
returned. Provider or graph failures degrade to the remaining channels.
### Attachments
Small image uploads can use the authenticated multipart endpoint:

```bash
curl -X POST "$HIAI_DOCS_URL/api/documents/$DOCUMENT_ID/attachments" \
  -H "Authorization: Bearer $HIAI_DOCS_API_KEY" \
  -F 'file=@screenshot.png'
```

For direct object-storage upload, call
`POST /api/documents/:id/attachments/presign`, upload to the returned URL, then
call `POST /api/documents/:id/attachments/confirm`. Attachment metadata can be
listed on the document and deleted by attachment ID.

`GET /api/attachments/:id/raw` streams bytes. It accepts the owner's session or
Bearer key. An anonymous share viewer must send a matching `x-share-token`.
Responses use private caching; missing, expired, foreign, or mismatched access
is rejected.
### Shares
```bash
curl -X POST "$HIAI_DOCS_URL/api/share" \
  -H "Authorization: Bearer $HIAI_DOCS_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"documentId":"'$DOCUMENT_ID'","expiresIn":"7d","role":"viewer"}'
# Public access; add x-share-password when the link is password protected.
curl "$HIAI_DOCS_URL/api/share/$SHARE_TOKEN"
```

Owners can list, update, and revoke links and manage guest email access. Links
may target documents or folders, use `viewer`, `commenter`, or `editor` roles,
and expire after `1h`, `1d`, `7d`, `30d`, or `never`.
### Versions and snapshots
```bash
curl -X POST "$HIAI_DOCS_URL/api/documents/$DOCUMENT_ID/versions" \
  -H "Authorization: Bearer $HIAI_DOCS_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"label":"v1.0","description":"Release snapshot"}'
```

Every create and update records a version. The API can list versions, retrieve
one version, create a named snapshot, restore a version, and compare versions.
Named snapshots are retained separately from automatic history pruning. A
restore first saves the current content and then triggers re-embedding.
## SDK, CLI, and MCP
All three clients use the same REST contract and Bearer keys. Prefer a category
key for a category-bound integration and a global key only for trusted
owner-wide automation.

| Interface | Best for | Entry point |
| --- | --- | --- |
| TypeScript SDK | Bun applications and typed service integration | `@hiai-gg/hiai-docs-sdk` |
| CLI | Shell workflows and human-operated automation | `hiai-docs` binary in `@hiai-gg/hiai-docs` |
| MCP server | AI clients and agent tool calling | `hiai-docs-mcp` binary in `@hiai-gg/hiai-docs` |

```bash
# CLI
bunx --package @hiai-gg/hiai-docs hiai-docs \
  init --url http://localhost:50700 --key "$HIAI_DOCS_API_KEY"
bunx --package @hiai-gg/hiai-docs hiai-docs search 'deployment guide'
# MCP server (stdio)
HIAI_DOCS_URL=http://localhost:50700 \
HIAI_DOCS_API_KEY="$HIAI_DOCS_API_KEY" \
bunx --package @hiai-gg/hiai-docs hiai-docs-mcp
```

```ts
import { DocsClient } from "@hiai-gg/hiai-docs-sdk";

const docs = new DocsClient({
  baseUrl: process.env.HIAI_DOCS_URL ?? "http://localhost:50700",
  apiKey: process.env.HIAI_DOCS_API_KEY,
});

const results = await docs.search("deployment guide");
```

The CLI covers configuration, document CRUD, search, folders, export, versions,
snapshots, and restore. The MCP server exposes equivalent document, search,
folder, snapshot, history, and export tools. Consult the package READMEs for
client-specific flags and tool schemas:

- [`packages/sdk/README.md`](../packages/sdk/README.md)
- [`packages/cli/README.md`](../packages/cli/README.md)
- [`packages/mcp-server/README.md`](../packages/mcp-server/README.md)
## Integration notes
- Server-to-server SDK, CLI, and MCP calls are not affected by browser CORS.
- Browser integrations must add their exact origin to `CORS_ORIGINS`.
- Never expose a global or operator credential in browser code.
- Use category keys to apply least privilege to Docsmint or another consumer.
- API-key lifecycle remains a browser-session-only owner operation.
- hiai-docs does not emit outbound attachment or document lifecycle webhooks.
  The deprecated `POST /api/webhooks/storage` route is a signed compatibility
  no-op; use REST, SDK, or MCP for integrations.
- The collaboration WebSocket is `WS /ws/collab/:documentId`; it accepts a
  session token or API key through the `token` query parameter.
## Complete contract
[`docs/openapi.json`](openapi.json) is the authoritative endpoint catalogue for
request bodies, query parameters, response schemas, validation limits, and
security declarations. This guide intentionally avoids duplicating that
generated surface.
