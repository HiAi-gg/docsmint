# API Reference

Base URL: `http://localhost:50700`

All responses are JSON. Errors follow `{ error: string, details?: unknown }`.

## Authentication

Most endpoints require a valid Better Auth session cookie. Public endpoints (health check, shared content access) are noted below.

```bash
# Sign in (sets session cookie)
curl -X POST http://localhost:50700/api/auth/sign-in \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "secret"}'

# Sign up
curl -X POST http://localhost:50700/api/auth/sign-up \
  -H "Content-Type: application/json" \
  -d '{"name": "User", "email": "user@example.com", "password": "secret"}'

# Verify health
curl -fsS http://localhost:50700/api/health
```

## Health

```
GET /api/health           # → { status: "ok", timestamp: "..." }
```

## Documents

```
GET  /api/documents       # List (paginated)
POST /api/documents       # Create
GET  /api/documents/:id   # Get with tags
PATCH /api/documents/:id  # Update (saves version)
DELETE /api/documents/:id # Delete (cascade)
```

### List documents

```bash
curl "http://localhost:50700/api/documents?page=1&limit=20&folderId=UUID&tag=UUID"
```

Response: `{ items: Document[], total: number, page: number, limit: number }`

### Create document

```bash
curl -X POST http://localhost:50700/api/documents \
  -H "Content-Type: application/json" \
  -d '{"title": "My Doc", "content": "Hello world", "folderId": "UUID"}'
```

### Update document

```bash
curl -X PATCH http://localhost:50700/api/documents/UUID \
  -H "Content-Type: application/json" \
  -d '{"title": "Updated", "content": "New content"}'
```

### Duplicate document

```bash
curl -X POST http://localhost:50700/api/documents/UUID/duplicate
```

Creates a copy with "(Copy)" suffix, including version snapshot and embedding queue.

### Export document

```bash
curl http://localhost:50700/api/documents/UUID/export
```

Returns the document content as a `.md` file download.

### Import document

```bash
# JSON import
curl -X POST http://localhost:50700/api/documents/import \
  -H "Content-Type: application/json" \
  -d '{"title": "Imported", "content": "# Hello"}'

# File upload
curl -X POST http://localhost:50700/api/documents/import \
  -F "file=@doc.md" \
  -F "folderId=UUID"
```

Supports `.md`, `.txt`, `.markdown`, `.json` files (max 10 MB).

### Document versions

```
GET  /api/documents/:id/versions                       # List version history
GET  /api/documents/:id/versions/:vid                  # Get specific version
POST /api/documents/:id/versions                       # Create named snapshot
POST /api/documents/:id/versions/:vid/restore          # Restore to version
GET  /api/documents/:id/versions/:vid1/diff/:vid2      # Diff two versions
```

Versions are auto-saved on every create/update. Each entry includes `id, content, contentJson, createdBy, createdAt, label, description, isSnapshot, restoredFrom`.

### Named Snapshots

Create a named, pinned version snapshot separate from auto-saved history.

```bash
curl -X POST http://localhost:50700/api/documents/UUID/versions \
  -H "Content-Type: application/json" \
  -d '{"label": "v1.0 Release", "description": "Production release version"}'
```

Body:

- `label` (required, 1-200 chars) — Snapshot name
- `description` (optional, max 1000 chars) — Description

Snapshots are never pruned by the auto-cleanup system.

### Restore Version

Restores a document to a specific version. Current content is automatically saved as a backup version before restore.

```bash
curl -X POST http://localhost:50700/api/documents/UUID/versions/VERSION_ID/restore
```

Returns the updated document. Triggers re-embedding.

### Version Diff

Returns a line-based diff between two versions.

```bash
curl http://localhost:50700/api/documents/UUID/versions/VID1/diff/VID2
```

Response:

```json
{
  "v1": { "id": "...", "label": "...", "createdAt": "..." },
  "v2": { "id": "...", "label": "...", "createdAt": "..." },
  "changes": { "added": 5, "removed": 2, "modified": 1 },
  "hunks": [
    { "type": "unchanged", "lines": ["line1"] },
    { "type": "remove", "lines": ["old line"] },
    { "type": "add", "lines": ["new line"] }
  ]
}
```

### Version List (Enhanced)

The existing `GET /api/documents/:id/versions` endpoint now supports:

| Param           | Type    | Description                          |
| --------------- | ------- | ------------------------------------ |
| `onlySnapshots` | boolean | If true, return only named snapshots |
| `limit`         | int     | Max results (1-500, default 100)     |

Each version entry now includes: `label`, `description`, `isSnapshot`, `restoredFrom`.

## Document Attachments

```
POST   /api/documents/:id/attachments             # Upload image attachment (auth required)
GET    /api/documents/:id/attachments             # List attachments (auth required)
GET    /api/attachments/:id/raw                  # Stream attachment bytes (gated, see below)
DELETE /api/attachments/:id                       # Remove attachment (auth required)
```

Image uploads are stored in SeaweedFS with integrity verification. Max file size: 10 MB. Only `image/*` MIME types accepted.

```bash
curl -X POST http://localhost:50700/api/documents/UUID/attachments \
  -F "file=@screenshot.png"
```

Response includes `id, filename, mimeType, size, url` (a stable same-origin
streaming URL — see `GET /api/attachments/:id/raw` below).

### Raw attachment streaming (gated)

```
GET /api/attachments/:id/raw
```

Returns the binary contents of the attachment. The response is a permanent
same-origin URL (no expiry), but the endpoint is **gated** — previously it was
public and relied on UUID unguessability, which leaked via referer headers,
browser caches, and link previews. The current behavior:

| Caller                                                                                                  | Outcome                         |
| ------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Authenticated as the document owner (session cookie OR `Authorization: Bearer <api-key>`)               | `200` with the bytes            |
| Authenticated as a different user                                                                       | `403` `Forbidden`               |
| Anonymous with `x-share-token: <token>` matching the document directly, or matching an enclosing folder | `200` with the bytes            |
| Anonymous with a missing / expired / mismatched share token                                             | `401` `Authentication required` |
| Anonymous without any token                                                                             | `401` `Authentication required` |

The response sets `Cache-Control: private, ...` so shared caches (CDNs,
proxies) cannot serve the auth-gated bytes to a different user hitting the
same URL.

```bash
# Owner
curl http://localhost:50700/api/attachments/UUID/raw \
  -H "Authorization: Bearer $API_KEY" -o image.png

# Anonymous share viewer (the share-view page passes the token through)
curl http://localhost:50700/api/attachments/UUID/raw \
  -H "x-share-token: $SHARE_TOKEN" -o image.png
```

> **Note**: `<img src="/api/attachments/UUID/raw">` tags inside shared documents
> must be rendered server-side with the share token attached, because browsers
> cannot set custom headers on plain `<img>` requests. The share-view page is
> responsible for that wiring; this endpoint only enforces the gate.

## Collaboration (WebSocket)

```
WS /ws/collab/:documentId              # Real-time collaborative editing
```

Uses Yjs for CRDT-based conflict resolution. Authentication via query param `?token=<session_token_or_api_key>`.

```bash
# Connect via wscat (install: npm install -g wscat)
wscat -c "ws://localhost:50700/ws/collab/DOCUMENT_ID?token=API_KEY"
```

Messages are JSON: `{ type: "sync" | "update" | "ping", update?: "base64", state?: "base64", clientId: number }`.

## Webhooks

```
POST /api/webhooks/storage               # SeaweedFS bucket event webhook
```

Verifies `x-storage-signature` header against `WEBHOOK_SECRET`. Currently handles `s3:ObjectRemoved:Delete` events to sync attachment DB records.

## Folders

```
GET    /api/folders         # List (tree, root-level unless ?parentId=UUID)
GET    /api/folders/:id     # Get single folder
POST   /api/folders         # Create
PATCH  /api/folders/:id     # Rename/move
DELETE /api/folders/:id     # Delete
```

### List folders

```bash
curl "http://localhost:50700/api/folders?parentId=UUID"
```

Returns root folders when `parentId` is omitted.

### Create folder

```bash
curl -X POST http://localhost:50700/api/folders \
  -H "Content-Type: application/json" \
  -d '{"name": "My Folder", "parentId": "UUID"}'
```

## Search

```
GET /api/search           # Full-text + semantic search (PUBLIC)
GET /api/search/suggest   # Quick title suggestions (PUBLIC)
```

### Full search

```bash
curl "http://localhost:50700/api/search?q=query&folder=UUID&tags=tag1,tag2&dateFrom=2026-01-01&dateTo=2026-12-31&sort=relevance&page=1&limit=20"
```

Query parameters:

| Param      | Type     | Description                                                   |
| ---------- | -------- | ------------------------------------------------------------- |
| `q`        | string   | Search query                                                  |
| `folder`   | UUID     | Filter by folder                                              |
| `tags`     | string   | Comma-separated tag names (ANY match)                         |
| `dateFrom` | ISO date | Filter docs created after                                     |
| `dateTo`   | ISO date | Filter docs created before                                    |
| `sort`     | enum     | `relevance`, `date_desc`, `date_asc`, `name_asc`, `name_desc` |
| `page`     | int      | Page number (default 1)                                       |
| `limit`    | int      | Per page (default 20, max 100)                                |

Response: `{ items: SearchResult[], total, page, limit }` where each item has `id, title, snippet, score, folderId, createdAt, updatedAt`.

### Quick suggest

```bash
curl "http://localhost:50700/api/search/suggest?q=deploy"
```

Returns top 5 title matches with similarity scores.

## Share Links

```
GET    /api/share           # List user's share links
POST   /api/share           # Create link
GET    /api/share/:token    # Access shared content (PUBLIC)
DELETE /api/share/:id       # Revoke link
POST   /api/share/:id/guests  # Add guest email
DELETE /api/share/:id/guests/:email  # Remove guest access
```

### Create share link

```bash
curl -X POST http://localhost:50700/api/share \
  -H "Content-Type: application/json" \
  -d '{"documentId": "UUID", "password": "optional", "expiresIn": "7d"}'
```

Expires options: `1h`, `1d`, `7d`, `30d`, `never`.

### Access shared content

```bash
# Public — no auth required. Rate limited: 10 req/min per IP.
curl http://localhost:50700/api/share/TOKEN

# With password
curl http://localhost:50700/api/share/TOKEN \
  -H "x-share-password: secret"
```

Returns 410 Gone if expired, 401 if password required/invalid.

## Tags

```
GET    /api/tags                        # List tags with counts
POST   /api/tags                       # Create tag
PATCH  /api/tags/:id                   # Update tag
DELETE /api/tags/:id                   # Delete tag
POST   /api/documents/:docId/tags      # Tag document
DELETE /api/documents/:docId/tags/:tagId # Untag document
```

## Agent Integration

hiai-docs is designed for AI agent integration via its REST API. Use API key authentication for programmatic access.

### API Key Auth

Set `HIAI_DOCS_API_KEY` in your `.env` file. All API requests use Bearer token:

```bash
curl -H "Authorization: Bearer $HIAI_DOCS_API_KEY" \
  http://localhost:50700/api/documents
```

### Semantic Search (RAG)

```bash
# Search documents by meaning (hybrid full-text + vector)
curl -H "Authorization: Bearer $HIAI_DOCS_API_KEY" \
  "http://localhost:50700/api/search?q=how+to+deploy+docker"

# Response includes relevance scores:
# { items: [{ id, title, content, score, rank }] }
```

### Document CRUD for Agents

```bash
# Create document
curl -X POST http://localhost:50700/api/documents \
  -H "Authorization: Bearer $HIAI_DOCS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "Agent Note", "content": "Important finding..."}'

# Read document
curl -H "Authorization: Bearer $HIAI_DOCS_API_KEY" \
  http://localhost:50700/api/documents/UUID

# Update document
curl -X PATCH http://localhost:50700/api/documents/UUID \
  -H "Authorization: Bearer $HIAI_DOCS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": "Updated with new findings..."}'
```

### Mastra Integration

```typescript
import { Mastra } from "@mastra/core";

const docsTool = {
  name: "search_knowledge",
  description: "Search the knowledge base for relevant documents",
  execute: async ({ query }) => {
    const res = await fetch(
      `http://localhost:50700/api/search?q=${encodeURIComponent(query)}`,
      { headers: { Authorization: `Bearer ${process.env.HIAI_DOCS_API_KEY}` } },
    );
    return res.json();
  },
};
```

## MCP Server

hiai-docs provides a Model Context Protocol (MCP) server for AI agent integration.

### Installation

```bash
cd packages/mcp-server && bun install
```

### Configuration

```json
{
  "mcpServers": {
    "hiai-docs": {
      "command": "bun",
      "args": ["run", "packages/mcp-server/src/index.ts"],
      "env": {
        "HIAI_DOCS_URL": "http://localhost:50700",
        "HIAI_DOCS_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Available Tools

| Tool                  | Description                        |
| --------------------- | ---------------------------------- |
| `search_documents`    | Hybrid full-text + semantic search |
| `get_document`        | Read document by ID                |
| `create_document`     | Create new document                |
| `update_document`     | Update document content            |
| `list_documents`      | List with filters/pagination       |
| `list_folders`        | List folder tree                   |
| `create_folder`       | Create a folder                    |
| `create_snapshot`     | Create named version snapshot      |
| `get_version_history` | Version history for a document     |
| `export_document`     | Export as markdown                 |

## CLI

A terminal CLI is available at `packages/cli/`.

### Installation

```bash
cd packages/cli && bun install
```

### Configuration

```bash
hiai-docs config --url http://localhost:50700 --key YOUR_API_KEY
```

### Commands

```bash
hiai-docs search "query"              # Search documents
hiai-docs list                         # List documents
hiai-docs read <id>                    # Read document
hiai-docs create --title "My Doc"      # Create document
hiai-docs update <id> --content "..."  # Update document
hiai-docs snapshot <id> --name "v1.0"  # Create snapshot
hiai-docs history <id>                 # Version history
hiai-docs restore <id> --version <vid> # Restore version
hiai-docs export <id>                  # Export as markdown
hiai-docs folders                      # List folders
```

## Error Codes

| Code | Meaning                                   |
| ---- | ----------------------------------------- |
| 400  | Validation error (check `details`)        |
| 401  | Not authenticated                         |
| 403  | Forbidden (not owner)                     |
| 404  | Resource not found                        |
| 410  | Share link expired                        |
| 429  | Rate limited (check `retry-after` header) |
| 500  | Internal server error                     |

## Admin

All admin endpoints require the static `HIAI_DOCS_API_KEY` via the `x-api-key` header (or `Authorization: Bearer`). These routes are intentionally operator-scoped — they are NOT per-user. When `HIAI_DOCS_API_KEY` is unset, the routes are open (dev convenience only).

### `POST /api/admin/reindex/:docId`

Force re-embed a single document. Drops existing chunks and enqueues the id so the worker picks it up on the next tick. Returns 404 when the document does not exist.

```bash
curl -X POST -H "x-api-key: $HIAI_DOCS_API_KEY" \
  http://localhost:50700/api/admin/reindex/$DOC_ID
```

Response:

```json
{
  "success": true,
  "documentId": "...",
  "message": "Existing embeddings cleared and document re-queued"
}
```

### `GET /api/admin/embedding-stats`

Pipeline observability: documents with embeddings, total chunks, and zero-vector (provider-failed) chunks.

```bash
curl -H "x-api-key: $HIAI_DOCS_API_KEY" \
  http://localhost:50700/api/admin/embedding-stats
```

Response:

```json
{
  "stats": {
    "docsWithEmbeddings": 142,
    "totalChunks": 873,
    "emptyChunks": 0
  }
}
```

A non-zero `emptyChunks` count is a strong signal that `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` / `EMBEDDING_API_KEY` are missing or wrong.

### `GET /api/admin/health/embeddings`

Live probe of the configured embedding provider. Status is one of:

- `ok` — provider returned a non-zero vector.
- `degraded` — provider returned a zero vector (auth failure or wrong model name) OR the provider raised and the fallback also failed. Pipeline runs but produces useless vectors.
- `not-configured` — `EMBEDDING_BASE_URL` or `EMBEDDING_MODEL` is unset; semantic search degrades to text-only.

```bash
curl -H "x-api-key: $HIAI_DOCS_API_KEY" \
  http://localhost:50700/api/admin/health/embeddings
```

Response (healthy):

```json
{
  "status": "ok",
  "provider": {
    "baseUrl": "https://api.openai.com/v1",
    "model": "text-embedding-3-small"
  },
  "latencyMs": 124,
  "dimensions": 1536
}
```

### `POST /api/admin/reindex/model?dryRun=true`

Targeted re-embed for documents whose stored `embedding_model` does not match the currently configured `EMBEDDING_MODEL`. Use this after changing `EMBEDDING_MODEL` in `.env` and restarting.

**Always run with `?dryRun=true` first** to preview the affected count.

```bash
# Preview
curl -X POST -H "x-api-key: $HIAI_DOCS_API_KEY" \
  "http://localhost:50700/api/admin/reindex/model?dryRun=true"
# {"dryRun": true, "currentModel": "text-embedding-3-small", "affectedDocs": 142}

# Commit
curl -X POST -H "x-api-key: $HIAI_DOCS_API_KEY" \
  "http://localhost:50700/api/admin/reindex/model"
# {"success": true, "currentModel": "text-embedding-3-small", "affectedDocs": 142, "enqueued": 142}
```

Dedup is handled by the shared `enqueueReembed` helper (Redis `SET NX EX 5`), so a rapid re-trigger coalesces into a single worker tick.

### `GET /api/admin/graph/stats`

Apache AGE inventory — total node and edge counts. Returns `{ available: false, reason: "..." }` when GraphRAG is disabled, when AGE is unreachable or the extension is not installed in the shared database.

```bash
curl -H "x-api-key: $HIAI_DOCS_API_KEY" \
  http://localhost:50700/api/admin/graph/stats
```

Response:

```json
{ "available": true, "nodes": 312, "edges": 547 }
```

### `GET /api/admin/metrics`

Process-local embedding metrics snapshot. Returns counter values and duration histogram samples from the in-process registry. Auth: API key via `x-api-key` header only (no session cookie). Rate-limited: shares the `searchRateLimiter` bucket.

```bash
curl -H "x-api-key: $HIAI_DOCS_API_KEY" \
  http://localhost:50700/api/admin/metrics
```

Response:

```json
{
  "metrics": {
    "embedAttempts": 142,
    "embedSuccesses": 140,
    "embedFailures": 2,
    "embedDurationMs": { "p50": 120, "p95": 340, "p99": 890 }
  },
  "uptime": 86423.4
}
```

The endpoint returns 401 when the `x-api-key` header is missing or does not match `HIAI_DOCS_API_KEY`.

### `POST /api/admin/reindex/folder/:folderId?dryRun=true`

Bulk re-embed every document in a folder. Operator-scoped (cross-user). Bounded by `FOLDER_REEMBED_BATCH_SIZE` (default `100`). Set `?dryRun=true` to preview the count without enqueuing.

```bash
curl -X POST -H "x-api-key: $HIAI_DOCS_API_KEY" \
  "http://localhost:50700/api/admin/reindex/folder/$FOLDER_ID?dryRun=true"
```

### `POST /api/admin/reindex/tag/:tagId?dryRun=true`

Bulk re-embed every document carrying a tag. Cross-user operator scope. Bounded by `TAG_REEMBED_BATCH_SIZE` (default `500`).

```bash
curl -X POST -H "x-api-key: $HIAI_DOCS_API_KEY" \
  "http://localhost:50700/api/admin/reindex/tag/$TAG_ID?dryRun=true"
```

## Search Graph Parameters

`GET /api/search` accepts three optional graph parameters, all gated by the `GRAPH_SEARCH_ENABLED` feature flag. When `GRAPH_SEARCH_ENABLED=false`, passing `graph=true` is a no-op (results are returned as if `graph=false`).

| Param        | Type        | Default                 | Description                                                                                                                                                |
| ------------ | ----------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graph`      | boolean     | `false`                 | When `true`, expand the merged result list with related documents discovered through the AGE graph.                                                        |
| `graphHops`  | int (1-3)   | `2`                     | Maximum graph traversal depth from each seed document. Higher hops surface more neighbors but with diminishing signal and `O(branching^hops)` cost in AGE. |
| `graphBoost` | float (0-2) | `GRAPH_EXPANSION_BOOST` | Override for the graph-neighbor score multiplier. When omitted, falls back to the operator-configured env var (default `0.3`).                             |

Example (graph-augmented search, 2-hop, default boost):

```bash
curl -H "Authorization: Bearer $HIAI_DOCS_API_KEY" \
  "http://localhost:50700/api/search?q=GraphRAG+architecture&graph=true&graphHops=2"
```

Graph expansion is best-effort: a graph outage logs a warning and returns the non-graph result list. Search never breaks because the graph is unavailable.

## Smart Re-embed System

Metadata mutations (tags, folders, categories) automatically trigger vector refresh to keep embeddings consistent. This system uses:

- **Incremental updates** — chunk hashing compares new vs. existing chunks; only changed slices are re-embedded
- **Neighbor expansion** — overlap regions are preserved across chunk boundaries
- **Redis deduplication** — rapid PATCH storms coalesce into a single worker tick (5-second TTL)
- **Batch caps** — prevent spikes: `FOLDER_REEMBED_BATCH_SIZE`, `CATEGORY_REEMBED_BATCH_SIZE`, `TAG_REEMBED_BATCH_SIZE`

Triggers:

- Tag rename/delete → `reembedDocsByTag(tagId)`
- Folder rename/delete → `reembedDocsInFolder(folderId, ownerId)`
- Category rename/delete → `reembedDocsInCategory(categoryId, ownerId)`
- Document update → `enqueueReembed([docId])`

## Admin API Errors

| Code | Meaning                                                                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 401  | Missing or invalid `x-api-key`                                                                                                            |
| 404  | Resource not found (e.g. `/reindex/:docId` for unknown doc id)                                                                            |
| 429  | Rate limited (admin endpoints share `searchRateLimiter` — a valid API key bypasses the bucket but a misconfigured caller still gets 429s) |
| 500  | Internal server error (see server logs)                                                                                                   |
