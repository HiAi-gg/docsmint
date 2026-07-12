# Import / Upload

> Status: **stable** (multi-file and DOCX support added in the
> 5-features rollout)
> Endpoint: `POST /api/documents/import`

The import endpoint accepts both a JSON body (single virtual item) and a
`multipart/form-data` body (one or more uploaded files). Both shapes
return the same response envelope so client code can stay uniform.

## Allowed file types

| Extension                | Parser                | Notes |
| ------------------------ | --------------------- | ----- |
| `.md` / `.markdown`      | Plain text read       | Title derived from the filename (extension stripped). |
| `.txt`                   | Plain text read       | Same as above. |
| `.json`                  | Zod-validated parse   | Body must match `{ title?, content, folderId? }`. Title falls back to filename. |
| `.docx`                  | mammoth → Markdown    | DOCX is converted to Markdown; title is the filename minus `.docx`. |

Maximum file size: **10 MB** per file.
Maximum batch size: **10 files** and **50 MB** of file data. Converted content
(notably DOCX, which can expand while parsing) is capped at **25 MB** per file.

The same-origin SvelteKit proxy accepts up to **100 MB per request** so a
multipart batch can reach the backend. The backend remains the source of truth:
it applies the stricter 10-file / 50 MB batch envelope before processing, as
well as the per-file and converted-content limits above. This avoids the
adapter-node default 512 KiB limit causing a
generic `413 Payload Too Large` before the API can return the actionable
per-file error.

## Single file (JSON path)

```http
POST /api/documents/import
Content-Type: application/json

{
  "title": "My imported doc",
  "content": "# Heading\n\nBody…",
  "folderId": "00000000-0000-4000-8000-000000000abc"
}
```

`folderId` is optional. Returns `201 Created` with the new document and
the standard `{ documents, total }` envelope.

## Multi-file (multipart path)

Send one or more files under the `file` form field. `folderId` is read
from the form-data and applied to every imported file in the batch.

```http
POST /api/documents/import
Content-Type: multipart/form-data; boundary=…

--…
Content-Disposition: form-data; name="folderId"

00000000-0000-4000-8000-000000000abc
--…
Content-Disposition: form-data; name="file"; filename="intro.md"
Content-Type: text/markdown

# Intro

This is the intro.
--…
Content-Disposition: form-data; name="file"; filename="chapter-1.md"
Content-Type: text/markdown

# Chapter 1

Body of chapter one.
--…--
```

Response (201):

```json
{
  "documents": [
    { "id": "doc-1-uuid", "title": "intro" },
    { "id": "doc-2-uuid", "title": "chapter-1" }
  ],
  "total": 2
}
```

The backend creates the documents inside a single transaction — if any
single file fails to parse, the entire batch rolls back. The client can
retry without worrying about partial imports leaving the DB inconsistent.

## DOCX parsing

DOCX files go through `mammoth.convertToMarkdown` which preserves
headings, lists, bold/italic, links, and code blocks. mammoth emits
non-fatal warnings for unsupported styles and ignored images; those are
logged server-side but never block the conversion.

Parse failures are surfaced as `422 Unprocessable Entity` with a
descriptive `error` message (e.g. encrypted documents, corrupt ZIP
headers). The `DocxParseError` type carries the original `fileName` and
`cause` for log correlation.

## Frontend UX

The dashboard import button (`frontend/src/routes/(app)/+page.svelte`)
opens a file picker with `multiple` enabled. The picker accepts
`.md`, `.txt`, `.json`, `.markdown`, `.docx` (case-insensitive).

While the batch uploads, `ImportProgress.svelte` renders an overlay
with one row per file showing the lifecycle:

```
uploading → processing → done | error
```

Per-row state is reconciled against the server's response by matching
the filename. Failed files surface the error message inline; the user
can dismiss the overlay or click "View all" to jump to the dashboard.

## Embedding

Every successfully imported document is enqueued for embedding via the
worker queue. The worker resolves the document's folder, tag, and
category names and prepends them to the chunk text before
vectorization, so semantic search benefits from the import metadata
immediately. Re-embedding is idempotent — running
`bun run scripts/reembed-all.ts` (see
[Re-embedding Backfill](#re-embedding-backfill)) refreshes the vectors
without producing duplicates.

Full document content remains available to chunking and embeddings. PostgreSQL
lexical search strips inline `data:` image payloads and indexes a bounded text
prefix so large supported documents cannot exceed PostgreSQL's 1 MiB `tsvector`
limit.

### Migration 0033 operational note

Migration `0033_bound_document_search_vectors` replaces both stored generated
`tsvector` columns and rebuilds their GIN indexes. PostgreSQL takes an
`ACCESS EXCLUSIVE` lock on `documents` while replacing the columns, and the
index rebuild scans the table. Writes and reads that touch `documents` can
therefore wait until the migration transaction completes.

For a new installation this is part of initial bootstrap and needs no separate
maintenance step. For an upgraded installation with a large `documents` table,
schedule a maintenance window and allow disk headroom for rebuilding both GIN
indexes. Runtime is proportional to total document text; measure a production
snapshot or staging clone rather than extrapolating from an empty database.
Do not start API containers until the one-shot `migrate` service reports
success; the provided Compose dependency already enforces this ordering.
The rollback-only verification in
`packages/db/scripts/large-document-search-smoke.sql` exercises a document
larger than 1 MiB, a large inline data image, multilingual insert/update
search, both generated columns, and both GIN indexes.

Run the complete fresh-install and pre-0033 upgrade contours with:

```bash
packages/db/scripts/test-large-document-migration.sh
```

The runner creates isolated temporary databases, applies the production AGE
bootstrap prerequisite, runs the complete journal on the fresh contour, runs
through 0032 and then 0033 on the upgrade contour, executes the rollback-only
SQL assertions on both, and removes the temporary databases on exit.

## Errors

| Status | When |
| ------ | ---- |
| `400` | Invalid JSON body (Zod validation), or empty multipart body. |
| `403` | CSRF middleware blocks the request (missing/invalid token). |
| `413` | A file exceeds 10 MB, converted content exceeds 25 MB, or a batch exceeds 10 files / 50 MB. |
| `415` | An unsupported file extension or content type. |
| `422` | DOCX parsing failed (corrupt file, encrypted document). |
| `429` | Per-IP rate limit exceeded. |
| `500` | Unhandled database / server error. |

## Re-embedding Backfill

If you add a new embedding-enrichment field (e.g. a new column on
`documents`) you can rebuild every embedding with:

```bash
cd backend
bun run reembed                # default batch-size=50, delay-ms=1000
bun run reembed -- --dry-run   # inspect without touching the queue
bun run reembed -- --batch-size=10 --delay-ms=2000
```

The script walks every document in the database, enqueues it for
embedding, and logs progress per batch. It is idempotent — running it
twice produces the same final embeddings as running it once.
