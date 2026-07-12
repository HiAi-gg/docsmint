# @hiai-gg/hiai-docs-sdk

A typed TypeScript client for the [hiai-docs](https://github.com/hiai-gg/hiai-docs) REST API. Bun-native `fetch`-based wrapper with Bearer auth, typed responses, and automatic retries with exponential backoff.

> Bun-native, ESM-only, TypeScript strict.

---

## Installation

```bash
bun add @hiai-gg/hiai-docs-sdk
# or
npm install @hiai-gg/hiai-docs-sdk
```

The SDK has no runtime dependencies.

## Quick start

```ts
import { DocsClient } from "@hiai-gg/hiai-docs-sdk";

const client = new DocsClient({
  baseUrl: process.env.HIAI_DOCS_URL ?? "http://localhost:50700",
  apiKey: process.env.HIAI_DOCS_API_KEY ?? "",
});

// List documents (paginated, optional folder/tag filter)
const list = await client.listDocs({ folderId: "…", limit: 50 });
console.log(list.items[0].title);

// Read full markdown
const md = await client.getDocMarkdown(list.items[0].id);

// Search (hybrid full-text + semantic)
const hits = await client.search("quarterly planning", { limit: 10 });

// Versioning
const versions = await client.listVersions(docId, { onlySnapshots: true });
const snapshot = await client.createDoc({ title: "v1.0", content: "…" });
```

## Configuration

```ts
new DocsClient({
  baseUrl: string,        // required
  apiKey?: string,        // global/category Bearer key; operator key only for admin calls
  timeout?: number,       // per-request ms, default 10 000
  retries?: number,       // attempts for 502/503/504/timeouts, default 3
  retryBackoffMs?: number,// initial backoff ms, doubles each attempt, default 250
});
```

## API surface

### Documents
- `createDoc({ title, content, folderId, categoryId, visibility })` → `DocsDocument`
- `getDoc(id)` → `DocsDocument`
- `getDocMarkdown(id)` → `string` (raw markdown)
- `updateDoc(id, { title, content, contentJson, metadata, folderId, categoryId, visibility })` → `DocsDocument`
- `deleteDoc(id)`
- `listDocs({ folderId, tag, page, limit })` → `DocsDocumentListResponse`
- `duplicateDoc(id)` → `DocsDocument`
- `exportDoc(id)` → alias of `getDocMarkdown`
- `importDoc({ title, content, folderId })` → `DocsDocument`
- `getDocumentPipeline(id)` → durable BullMQ stage/batch status
- `publishDoc(id)` / `unpublishDoc(id)`

### Folders
- `listFolders(parentId?)` → `DocsFolder[]`
- `getFolder(id)` → `DocsFolder`
- `createFolder({ name, parentId?, categoryId? })` → `DocsFolder`
- `updateFolder(id, { name, parentId, categoryId, order })` → `DocsFolder`
- `deleteFolder(id)`

### Tags
- `listTags()` → `DocsTag[]`
- `createTag({ name, color? })` → `DocsTag`
- `updateTag(id, { name, color? })` → `DocsTag`
- `deleteTag(id)`
- `addTagToDoc(documentId, tagId)`
- `removeTagFromDoc(documentId, tagId)`

### Search
- `search(query, { folder, tags, dateFrom, dateTo, sort, page, limit })` → `DocsSearchResponse`
- `suggest(query)` → `DocsSearchSuggestItem[]`

### Share
- `createShare({ documentId, folderId, password, expiresIn })` → `DocsShareLink`
- `listShares()` → `DocsShareListResponse`
- `deleteShare(id)`
- `getShareByToken(token)` → `DocsSharedContent`

### Attachments
- `uploadAttachment(documentId, blob, filename, mimeType)` → `DocsAttachment`
- `presignAttachment(documentId, input)` / `confirmAttachment(documentId, input)`
- `listAttachments(documentId)` → `DocsAttachmentListResponse`
- `deleteAttachment(id)`

### Versions
- `listVersions(documentId, { onlySnapshots, limit })` → `DocsVersion[]`
- `getVersion(documentId, versionId)` → `DocsVersion`

### Health
- `health()` → `DocsHealthResponse`

## Errors

All non-OK responses throw `DocsApiError`:

```ts
import { DocsApiError } from "@hiai-gg/hiai-docs-sdk";

try {
  await client.getDoc(id);
} catch (err) {
  if (err instanceof DocsApiError) {
    console.error(`API ${err.status}:`, err.body);
  } else {
    throw err;
  }
}
```

Network-level failures (DNS, ECONNRESET, ETIMEDOUT, fetch timeout) are wrapped in a plain `Error` with `cause` set to the original.

## Retries

Transient failures are retried automatically with exponential backoff:

- HTTP `502`, `503`, `504`
- Fetch `TimeoutError` / `AbortError`
- Network errors with `cause.code` of `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`

Configure with `retries` (default 3) and `retryBackoffMs` (default 250 ms). Backoff doubles each attempt with up to 25 % jitter.

## Authentication and API keys

The SDK sends `Authorization: Bearer <apiKey>` when configured. Normal integrations should use a key created in the web settings:

- global scope: all content owned by that user;
- category `read`: list/get/search/export in one effective category;
- category `edit`: modify existing content, tags, attachments, and versions in that category;
- category `write`: create/move/delete/share/publish in that category.

Permissions are explicit and non-hierarchical. Combine category permissions as needed. The static server `HIAI_DOCS_API_KEY` is an operator credential for `/api/admin/*`, not the normal user integration key.

Key lifecycle methods are available for session-backed application flows: `createGlobalApiKey`, `createCategoryApiKey`, `listApiKeys`, `revealCategoryApiKey`, and `revokeApiKey`. Supply a Better Auth cookie or authorization value through `DocsRequestContext`; API keys cannot manage other API keys. Global secrets are shown once, while category secrets are recoverable by the owning browser session.

```ts
const keys = await client.listApiKeys({ cookie: request.headers.get("cookie") ?? "" });
```

## Type safety

Every method returns a strongly-typed shape from `./types`. The `types.ts` file mirrors the backend Elysia routes — keep both in sync if you change the API surface.

## Build & test

```bash
cd packages/sdk
bun run typecheck    # tsc --noEmit
bun run build        # tsc → dist/
```

## License

MIT
