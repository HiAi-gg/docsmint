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
GET /api/documents/:id/versions        # List version history
GET /api/documents/:id/versions/:vid   # Get specific version
```

Versions are auto-saved on every create/update. Each entry includes `id, content, contentJson, createdBy, createdAt`.

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
