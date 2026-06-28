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

# Get current session
curl http://localhost:50700/api/auth/session

# Sign out
curl -X POST http://localhost:50700/api/auth/sign-out
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

| Param | Type | Description |
|-------|------|-------------|
| `onlySnapshots` | boolean | If true, return only named snapshots |
| `limit` | int | Max results (1-500, default 100) |

Each version entry now includes: `label`, `description`, `isSnapshot`, `restoredFrom`.

## Document Attachments

```
POST /api/documents/:id/attachments    # Upload image attachment
GET  /api/documents/:id/attachments    # List attachments
```

Image uploads are stored in MinIO with integrity verification. Max file size: 10 MB. Only `image/*` MIME types accepted.

```bash
curl -X POST http://localhost:50700/api/documents/UUID/attachments \
  -F "file=@screenshot.png"
```

Response includes `id, filename, mimeType, size, url` (presigned S3 URL, 24h expiry).

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
POST /api/webhooks/minio               # MinIO bucket event webhook
```

Verifies `x-minio-signature` header against `WEBHOOK_SECRET`. Currently handles `s3:ObjectRemoved:Delete` events to sync attachment DB records.

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

| Param | Type | Description |
|-------|------|-------------|
| `q` | string | Search query |
| `folder` | UUID | Filter by folder |
| `tags` | string | Comma-separated tag names (ANY match) |
| `dateFrom` | ISO date | Filter docs created after |
| `dateTo` | ISO date | Filter docs created before |
| `sort` | enum | `relevance`, `date_desc`, `date_asc`, `name_asc`, `name_desc` |
| `page` | int | Page number (default 1) |
| `limit` | int | Per page (default 20, max 100) |

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
      { headers: { Authorization: `Bearer ${process.env.HIAI_DOCS_API_KEY}` } }
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

| Tool | Description |
|------|-------------|
| `search_documents` | Hybrid full-text + semantic search |
| `get_document` | Read document by ID |
| `create_document` | Create new document |
| `update_document` | Update document content |
| `list_documents` | List with filters/pagination |
| `list_folders` | List folder tree |
| `create_folder` | Create a folder |
| `create_snapshot` | Create named version snapshot |
| `get_version_history` | Version history for a document |
| `export_document` | Export as markdown |

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

| Code | Meaning |
|------|---------|
| 400  | Validation error (check `details`) |
| 401  | Not authenticated |
| 403  | Forbidden (not owner) |
| 404  | Resource not found |
| 410  | Share link expired |
| 429  | Rate limited (check `retry-after` header) |
| 500  | Internal server error |
