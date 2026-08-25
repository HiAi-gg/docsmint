# Architecture

## Account pipeline cancellation

Server hosts compose `cancelAccountPipelineJobs` from
`@hiai-gg/docsmint/pipeline/cancellation` into the persistent lifecycle
runtime's `cancelAccountJobs` adapter. The supplied `cancelRuns` callback must
run in the actor's request/RLS scope and atomically mark every non-terminal
owned pipeline run `cancelled`. Only BullMQ jobs whose payload contains the
exact matching `ownerId` are removed, and only while waiting, delayed, paused,
or prioritized. Active jobs are never force-removed: prepare/embed adapters
check the durable cancellation fence immediately before each write. Redis
queue namespaces must never be deleted as an account-cancellation shortcut.

The packaged backend composition accepts `{ redisUrl, databaseUrl }`. Each
instance owns its BullMQ handles and postgres-js pool; `close()` releases only
those owned resources, so a new instance can be created safely afterward.

## Account purge admission fence

After the host policy gate accepts account deletion, the OSS lifecycle records
its hashed fence token under a stable per-subject advisory transaction lock.
Guarded statements collect every direct actor and parent-derived owner across
their transition tables, lock parent rows before resolving current ownership,
then acquire all subject locks once in canonical UUID order. A write already in
progress therefore commits before the fence snapshot; a later write fails with
database constraint `account_purge_fenced`. Rejected host gates remain writable,
retryable purges remain closed, and completed tombstones remain permanently
fenced.

The guard covers personal and workspace documents, restore/import/duplicate
paths, folder/tag/category and sharing metadata, attachment uploader and version
creator attribution, pipeline admission, API keys, sessions, accounts, audit
actors, and Better Auth user updates. Existing pipeline status rows may still
transition to cancellation after a fence, while new runs and batches cannot be
inserted. Lifecycle cleanup uses only an exact running-operation/lease token;
there is no caller-settable generic bypass. Final document cleanup snapshots the
current owner-wide ID union, acquires shared pipeline advisory locks once in
canonical order, and then cascades deletion. Guarded public mutations return
`409` with code `ACCOUNT_PURGE_FENCED`.

Direct attachment presign first commits a forced-RLS admission row containing
the exact actor, parent document, workspace, object key, signed-token hash,
quota reservation, and expiry. Confirm consumes that admission atomically. Once
the signed key is authenticated, every failed confirm owns deletion of that
exact object; an unauthenticated or tampered key cannot delete it. Account purge
also removes workspace-peer objects attributed to the purged uploader, but does
not complete while any previously issued PUT URL is still valid. Bounded
startup/periodic recovery removes expired unconfirmed objects without delaying
API readiness.

## Monorepo Structure

```
docsmint/
├── backend/              # Elysia REST API (Bun runtime)
│   └── src/
│       ├── api/routes/   # Route handlers (documents, folders, search, share, tags, auth, metrics)
│       ├── api/middleware/# Auth, rate-limit middleware
│       ├── embedding/    # Embedding pipeline (chunker, providers, queue)
│       └── lib/          # Shared utilities
│           ├── redis-factory.ts  # Pure createRedis(cfg) factory — no config dependency
│           ├── storage-factory.ts   # Pure createObjectStorageClient(cfg) + ensureBucket() factory
│           ├── redis.ts          # Singleton re-export wrapper (→ redis-factory)
│           ├── storage.ts          # Singleton re-export wrapper (→ storage-factory)
│           ├── with-tenant.ts    # Re-export shim → packages/db/src/with-tenant
│           └── metrics.ts        # In-process metrics registry
├── frontend/             # SvelteKit 2 + Svelte 5 + Tailwind CSS v4
│   └── src/
│       ├── routes/       # Pages (+page.svelte per route)
│       └── lib/
│           ├── components/ # UI components (sidebar, editor, cards)
│           ├── components/ui/ # shadcn-svelte primitives
│           └── api/      # API client functions
├── packages/db/          # Drizzle ORM schema + migrations (shared)
│   └── src/
│       ├── schema.ts     # Table definitions + relations
│       ├── client.ts     # Drizzle database client
│       └── with-tenant.ts # RLS client: withTenant, TenantContext, adminTenantContext, shareGuestTenantContext
└── docker-compose.yml    # Full stack deployment
```

### Module Boundaries & DI Factories

The `backend/src/lib/` directory uses a **factory pattern** so optional public
subpath imports can reuse Redis and SeaweedFS infrastructure without coupling
to DocsMint's `.env` validation:

| File | Purpose | For external use? |
|------|---------|-----------------|
| `redis-factory.ts` | Pure `createRedis(cfg: RedisConfig)` — no `config.ts` import | ✅ Yes — `@hiai-gg/docsmint/backend/lib/redis` |
| `storage-factory.ts` | Pure `createObjectStorageClient(cfg)` + `ensureBucket()` | ✅ Yes — `@hiai-gg/docsmint/backend/lib/storage` |
| `redis.ts` | Backwards-compatible singleton (calls factory with `config.REDIS_URL`) | Internal only |
| `storage.ts` | Backwards-compatible singletons (`storage`, `storagePublic`) | Internal only |
| `with-tenant.ts` | Thin re-export shim → `packages/db/src/with-tenant` | ✅ Yes — `@hiai-gg/docsmint/db/with-tenant` |
| `metrics.ts` | In-process embedding metrics registry | Internal only |

**npm subpath exports** (see `package.public.json` exports field):

```ts
// RLS-tenant-scoped queries (from shared package)
import { withTenant, adminTenantContext } from "@hiai-gg/docsmint/db/with-tenant";

// Pure factories — no DocsMint config dependency
import { createRedis } from "@hiai-gg/docsmint/backend/lib/redis";
import { createObjectStorageClient } from "@hiai-gg/docsmint/backend/lib/storage";

// Schema access
import { documents, folders } from "@hiai-gg/docsmint/schema";
```

The RLS context (`with-tenant.ts`) lives in `packages/db/` so the backend and
documented database subpath exports use the same transaction boundary.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Bun 1.3.14+ |
| Backend | Elysia 1.4.28+ |
| ORM | Drizzle 0.45.2+ |
| Database | PostgreSQL 18 + pgvector |
| Cache | Redis 8 (`redis:8-alpine` reference image) |
| Auth | Better Auth |
| Frontend | SvelteKit 2.60+ / Svelte 5.55+ |
| UI | shadcn-svelte (new-york) + Tailwind v4 |
| Editor | TipTap + svelte-tiptap |
| Embeddings | OpenAI-compatible API with optional self-hosted Ollama; validated 1024-dimensional generations |
| Search | Exact/title, multilingual FTS, fuzzy, vector, adaptive expansion, GraphRAG, and RRF |
| Graph | Apache AGE in the same PostgreSQL instance; automatic in the reference profile |
| Storage | SeaweedFS (S3-compatible) |

## Data Flow

```
User → SvelteKit Frontend → REST API (Elysia) → PostgreSQL
                                              → Redis (queue/cache)
                                               → SeaweedFS (attachments)
                                              → Embedding API or Ollama (graceful fallback)
                                              → Apache AGE (automatic GraphRAG expansion)
```

1. User creates/edits document in TipTap editor
2. Frontend PATCHes document via API
3. API saves content + version to PostgreSQL
4. API enqueues an embedding generation job to Redis
5. Background worker fetches document, chunks text, validates provider vectors, and stages a candidate generation
6. Worker atomically activates a complete finite/non-zero 1024-dimensional generation; failed candidates leave the prior generation active
7. After activation, the worker performs GraphRAG entity extraction into AGE

## Durable BullMQ document pipeline

Document processing is a five-stage BullMQ pipeline backed by PostgreSQL state:

```text
prepare → embed (chunk batches) → graph → summarize → finalize
```

Each stage has its own worker, retry policy, concurrency, and dead-letter
handling. PostgreSQL is the recovery source of truth for the document
generation, revision fence, stage status, batch progress, attempts, errors,
heartbeats, and idempotency. Redis/BullMQ carries executable jobs; it is not the
canonical document store. Queue-state tables never store document bodies or
model output.

Metadata changes use the same durability rule. Folder, category, tag, document
placement, and document-tag mutations insert an exact document/revision
snapshot into `metadata_reembed_outbox` while holding the tenant-scoped
topology advisory lock. The outbox row ID is a metadata-event-specific
generation ID, so two successive metadata mutations remain distinct even when
document content is unchanged. The mutation transaction commits before Redis
or BullMQ I/O begins.
Dispatch stages each bounded page with a fixed number of set-based PostgreSQL
statements, submits one BullMQ bulk write, and acknowledges only admitted or
already-complete rows. Failed rows remain durable; after workers become ready,
startup recovery retries their deterministic generation and job IDs in the
background. Staging mutates only embedding lifecycle fields: document content
revision and `updatedAt` remain owned by the user mutation that created them.
Bulk staging and every worker transaction that locks both a document and its
pipeline run first acquire the same per-document transaction advisory lock;
hard document purges and other executable document cascade-deletion paths join
the same protocol before deletion. Multi-document operations acquire those
locks in deterministic order. The
`*_REEMBED_BATCH_SIZE` settings control page memory, not total coverage. A
configured value of `0` falls back to the safe domain default.

Embedding work is split into bounded batches (five chunks by default). A large
document therefore cannot occupy the entire ready queue: only the configured
number of unfinished batches for that document is scheduled at once. A batch
that is already complete is idempotent on retry, and a stale revision is
cancelled before it can activate embeddings.

### Multi-user fairness

Fairness controls limit active work, not submissions. Requests are not rejected
because another owner has many queued documents. Owner-aware leases and
per-document batch windows ensure that one owner or one large document cannot
monopolize workers while other owners make progress. The planned defaults are:

- `QUEUE_MAX_ACTIVE_PREPARE_PER_OWNER=2`
- `QUEUE_MAX_ACTIVE_EMBED_PER_OWNER=4`
- `QUEUE_MAX_ACTIVE_GRAPH_PER_OWNER=1`
- `QUEUE_MAX_ACTIVE_BATCHES_PER_DOCUMENT=2`

These controls are separate from provider throttling. Provider limiter modes
are `disabled` (worker concurrency only), `local` (optional GPU-protection
concurrency cap, no API quota), and `remote` (concurrency, requests/minute,
backoff, and `Retry-After` handling).

Search queries run exact/title, language-neutral lexical, fuzzy, and active-generation vector retrieval in parallel. A deterministic confidence gate invokes at most one structured multilingual expansion pass when direct evidence is weak. Authorized AGE graph expansion then contributes related documents. Reciprocal rank fusion combines all channels with exact-title and channel-agreement boosts, finite-score/vector thresholds, and a graph contribution cap. If embeddings, expansion, or AGE are unavailable, the remaining channels still return results.

### Search and embedding invariants

- Every queryable embedding row belongs to `documents.active_embedding_generation`.
- A generation is ready only when every chunk row is valid, finite, non-zero, exactly 1024-dimensional, and profile-consistent.
- A failed or stale candidate never deletes the last active generation.
- Graph extraction runs only after generation activation.
- Query expansion cache keys are tenant-scoped hashes; provider credentials and raw prompts never enter metrics or public responses.
- Graph seed authorization and result hydration use the same owner/public/share visibility scope.

## Module Boundaries

- `api/` imports from `lib/` and `embedding/` — never the reverse
- `embedding/` imports from `lib/` only
- `lib/` has no imports from `api/` or `embedding/`
- `packages/db/` is imported by both backend and has no dependencies on either

## Security Model

- **Data isolation**: personal queries use `ownerId`; trusted external requests
  use the verified opaque `workspaceId` boundary and PostgreSQL RLS
- **Workspace child rows**: document tags, attachments, versions, embeddings,
  pipeline batches, and metadata outbox rows derive access from their parent
  document/run and require a matching nullable workspace value
- **Auth**: Better Auth session cookies (7-day expiry)
- **Sharing**: token-based links with optional password + expiry
- **Rate limiting**: public share resolution allows 60 req/min per IP; share
  mutations use the shared 5 req/min limiter.
- **Validation**: Zod schemas on all API inputs
- **No secrets in code**: all config via environment variables

## Integration and authorization boundary

REST is the canonical boundary used by the SDK, CLI, and MCP server. The public
package exposes typed SDK and schema contracts, but integrations must not
bypass owner/category authorization with direct database writes.

Authentication resolves to one principal: Better Auth session, static operator credential, global user API key, or category API key. Global keys receive owner-wide content access. Category keys are restricted to one effective category and an explicit set of `read`, `edit`, and `write` permissions; permissions do not imply each other. Effective category is the document's explicit category or, when absent, the category inherited from folder ancestry. This rule is shared by documents, folders, search, graph, versions, attachments, tags, sharing, and visibility.

Trusted hosts can additionally use the public signed workspace assertion
contract. Its optional `WorkspaceResourceScope` is category-only and carries
independent `read`, `edit`, and `write` permissions. Omitting the scope keeps
the established workspace-wide, role-derived compatibility behavior; an empty
scope permission array grants no content action. The assertion is verified only
at the server boundary and never turns into a browser credential. Restricted
queries apply the direct-or-inherited effective-category predicate before SQL
counting, pagination, retrieval, graph expansion, or index authorization.
Index status requires `read`; index refresh requires `write`.

API-key issuance, listing, category-secret disclosure, and revocation deliberately bypass the generic Bearer principal resolver and require a Better Auth browser session. Global raw secrets are hash-only and shown once. Category secrets are encrypted at rest so the owning session can recover them. The static operator key is accepted on admin routes through either `x-api-key` or Bearer syntax; an unset operator key fails closed.

DocsMint does not publish outbound document webhooks. The deprecated signed
storage webhook is a no-op compatibility endpoint, not a synchronization
mechanism. Integrations should use REST, SDK, or MCP and query the durable
document pipeline endpoint when they need processing readiness.
