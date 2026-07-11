# BullMQ GraphRAG Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single blocking Redis-list embedding worker with a durable, multi-stage BullMQ pipeline that remains fair across users, handles many documents and API-triggered imports, and can run without provider rate limits against local Ollama.

**Architecture:** PostgreSQL remains the source of truth for document generations, stage state, progress, idempotency, and recovery. BullMQ on the existing Redis instance executes five isolated stages (`prepare`, `embed`, `graph`, `summarize`, `finalize`) with independent concurrency, retries, priorities, and dead-letter behavior. The public API accepts work without artificial per-user document/job quotas; internal fair scheduling and backpressure prevent one user or large document from monopolizing workers.

**Tech Stack:** Bun 1.3.14+, TypeScript ESM, BullMQ OSS, Redis 8.6+, PostgreSQL 18.4, Drizzle ORM 0.45.2+, Elysia, OpenAI-compatible embedding/chat providers, optional local Ollama.

## Global Constraints

- Keep hiai-docs standalone: do not add Mastra, Temporal, BullMQ Pro, Node-only bootstrap code, npm, yarn, or CommonJS.
- Install `bullmq` in `backend/` with Bun and verify Queue/Worker/QueueEvents behavior under Bun before migrating production code.
- Preserve `owner_id` isolation on every pipeline read/write; `tenant_id` remains reserved until the project adopts tenant workspaces.
- Do not impose product quotas on local users or API clients. Safety limits for payload size, memory, and database integrity remain in force.
- Provider throttling is configurable and disabled by default for local Ollama profiles; remote-provider presets may enable concurrency/RPM limits.
- Every job is at-least-once and must be idempotent. PostgreSQL, not Redis, decides whether a generation or stage is current.
- A GraphRAG failure must not invalidate ready embeddings. Semantic search becomes available as soon as the embedding generation is activated.
- Reindex and backfill jobs use lower priority than interactive saves, imports, and API-created documents.
- All configuration is validated through `backend/src/lib/config-schema.ts` and documented in `.env.example` and `docs/DEPLOYMENT.md`.
- Code, comments, configuration descriptions, and documentation remain English-only.

---

## Target Pipeline

```text
UI/API save or import
        |
        v
  docs:prepare  (document-level, owner-aware)
        |
        +--> docs:embed batch 0 --+
        +--> docs:embed batch 1 --+--> atomic generation completion
        +--> docs:embed batch N --+
                                      |
                                      +--> activate embeddings --> semantic search ready
                                      |
                                      +--> docs:graph --> graph search ready
                                      |
                                      +--> docs:summarize (optional)
                                      |
                                      +--> docs:finalize
```

### Queue contract

```ts
export type PipelineStage =
  | "prepare"
  | "embed"
  | "graph"
  | "summarize"
  | "finalize";

export interface BasePipelineJob {
  documentId: string;
  ownerId: string;
  generationId: string;
  revision: string;
  requestedAt: string;
  source: "interactive" | "import" | "api" | "reindex" | "backfill";
}

export interface EmbedBatchJob extends BasePipelineJob {
  stage: "embed";
  batchIndex: number;
  totalBatches: number;
  chunkIndexes: number[];
}
```

### Initial concurrency defaults

| Stage | Concurrency | Job unit | Default timeout |
|---|---:|---|---:|
| Prepare/chunk | 2 | one document | 30s |
| Embed | 3 | up to 5 chunks | 20s/provider request |
| Graph extraction | 2 | one document generation | 30s/provider request |
| Summarize | 1 | one document generation | 30s/provider request |
| Finalize | 2 | one document generation | 10s |

These are worker concurrency values, not per-user quotas. Local Ollama operators change them only through documented environment variables.

---

## File Map

### New backend files

- `backend/src/queue/connection.ts` — BullMQ-compatible Redis connection factory and lifecycle.
- `backend/src/queue/contracts.ts` — versioned job payload schemas and deterministic job IDs.
- `backend/src/queue/names.ts` — queue names, priorities, and retry presets.
- `backend/src/queue/queues.ts` — Queue and QueueEvents instances.
- `backend/src/queue/enqueue.ts` — public enqueue facade replacing Redis `LPUSH`.
- `backend/src/queue/recovery.ts` — PostgreSQL reconciliation of unfinished generations.
- `backend/src/queue/workers/prepare.worker.ts` — snapshot metadata and chunk plan.
- `backend/src/queue/workers/embed.worker.ts` — bounded embedding batch execution.
- `backend/src/queue/workers/graph.worker.ts` — GraphRAG extraction isolated from embeddings.
- `backend/src/queue/workers/summarize.worker.ts` — optional summarization stage.
- `backend/src/queue/workers/finalize.worker.ts` — terminal state and cleanup.
- `backend/src/queue/start.ts` — worker startup and graceful shutdown.
- `backend/src/queue/provider-limiter.ts` — optional remote-provider limiter/circuit breaker.
- `backend/src/scripts/recover-pipeline.ts` — operator-triggered PostgreSQL-to-BullMQ reconciliation.
- `backend/src/scripts/smoke-bullmq-bun.ts` — Bun compatibility smoke.

### Modified files

- `backend/package.json`, `bun.lock` — BullMQ dependency and queue scripts.
- `backend/src/index.ts` — start and stop queue workers.
- `backend/src/lib/embedding-queue.ts` — compatibility facade delegating to the new enqueue service.
- `backend/src/embedding/worker.ts` — split reusable stage functions, then remove legacy loop.
- `backend/src/embedding/generation.ts` — revision fencing and per-stage transitions.
- `backend/src/lib/config-schema.ts` — queue concurrency, timeout, limiter, retention, and Ollama settings.
- `backend/src/lib/metrics.ts`, `backend/src/api/routes/metrics.ts` — stage queue depth, duration, retries, failures, and age.
- `backend/src/api/routes/documents.ts`, `versions.ts`, `admin.ts` — source/priority-aware enqueue calls.
- `backend/src/lib/reembed.ts` — low-priority metadata/reindex scheduling.
- `packages/db/src/schema.ts` — pipeline generation and batch state.
- `packages/db/src/migrations/0028_bullmq_pipeline_state.sql` — source-of-truth pipeline schema.
- `docker-compose.yml`, `.env.example` — workers and configuration.
- `docs/ARCHITECTURE.md` — queue architecture and failure semantics.
- `docs/DEPLOYMENT.md` — production and local Ollama tuning.
- `README.md` — short link to queue/Ollama documentation only.

---

### Task 1: Prove BullMQ Works Under Bun

**Files:**
- Modify: `backend/package.json`
- Modify: `bun.lock`
- Create: `backend/src/scripts/smoke-bullmq-bun.ts`
- Test: `backend/src/__tests__/bullmq-bun-smoke.test.ts`

**Interfaces:**
- Consumes: existing `REDIS_URL` configuration.
- Produces: `bun run smoke:bullmq` and verified support for Queue, Worker, retry, delayed job, QueueEvents, reconnect, and graceful close.

- [ ] **Step 1: Add the failing compatibility test**

Create a test that uses a unique queue name, adds a delayed job that fails once, observes `waiting → active → delayed → completed`, and asserts `attemptsMade === 2`.

```ts
const queueName = `hiai-docs-smoke-${crypto.randomUUID()}`;
const queue = new Queue(queueName, { connection });
let calls = 0;
const worker = new Worker(queueName, async () => {
  calls += 1;
  if (calls === 1) throw new Error("retry-me");
  return { ok: true };
}, { connection, concurrency: 2 });
await queue.add("smoke", {}, {
  attempts: 2,
  backoff: { type: "fixed", delay: 25 },
});
```

- [ ] **Step 2: Run the test before installation**

Run: `cd backend && bun test src/__tests__/bullmq-bun-smoke.test.ts`

Expected: FAIL because `bullmq` cannot be resolved.

- [ ] **Step 3: Install BullMQ in the backend workspace**

Run: `cd backend && bun add bullmq`

Do not install BullMQ at the monorepo root.

- [ ] **Step 4: Complete lifecycle assertions**

Assert completion, retry count, delayed execution, QueueEvents delivery, `worker.close()`, `queue.close()`, Redis disconnect/reconnect, and cleanup with `queue.obliterate({ force: true })` only for the unique smoke queue.

- [ ] **Step 5: Run the Bun smoke**

Run: `cd backend && bun test src/__tests__/bullmq-bun-smoke.test.ts && bun run typecheck`

Expected: PASS and no open-handle hang.

- [ ] **Step 6: Commit**

```bash
git add backend/package.json bun.lock backend/src/scripts/smoke-bullmq-bun.ts backend/src/__tests__/bullmq-bun-smoke.test.ts
git commit -m "test(queue): verify BullMQ on Bun"
```

---

### Task 2: Add Durable Pipeline State to PostgreSQL

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/src/migrations/0028_bullmq_pipeline_state.sql`
- Test: `packages/db/src/pipeline-schema.test.ts`
- Test: `packages/db/scripts/migrate.test.ts`

**Interfaces:**
- Produces: `documentPipelineRuns`, `documentPipelineBatches`, `pipelineStageEnum`, and unique idempotency constraints.
- Consumes: `documents.id`, `documents.ownerId`, and existing embedding generation UUIDs.

- [ ] **Step 1: Write schema tests**

Require these invariants:

```text
UNIQUE(document_id, generation_id)
UNIQUE(generation_id, batch_index)
INDEX(owner_id, status, updated_at)
INDEX(stage, status, available_at)
ON DELETE CASCADE from document
```

- [ ] **Step 2: Define stage and status enums**

```ts
export const pipelineStageEnum = pgEnum("pipeline_stage", [
  "prepare", "embed", "graph", "summarize", "finalize",
]);
export const pipelineStatusEnum = pgEnum("pipeline_status", [
  "pending", "processing", "ready", "retrying", "failed", "skipped", "cancelled",
]);
```

- [ ] **Step 3: Define run state**

Store `documentId`, `ownerId`, `generationId`, `revision`, `source`, per-stage statuses, total/completed/failed batches, error code, attempts, timestamps, and heartbeat. Do not store document bodies or model output in queue-state tables.

- [ ] **Step 4: Define batch state**

Store `generationId`, `batchIndex`, `chunkStart`, `chunkEnd`, `status`, `attempts`, `embeddingProfile`, and timestamps. Add a unique `(generationId, batchIndex)` constraint.

- [ ] **Step 5: Add migration and upgrade test**

Run the complete migration chain against a fresh PostgreSQL database and an upgraded pre-0028 database.

- [ ] **Step 6: Verify**

Run: `cd packages/db && bun test && bun run typecheck`

Expected: all schema and migration tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/migrations/0028_bullmq_pipeline_state.sql packages/db/src/pipeline-schema.test.ts packages/db/scripts/migrate.test.ts
git commit -m "feat(db): track document pipeline stages"
```

---

### Task 3: Create Versioned Queue Contracts and Enqueue Facade

**Files:**
- Create: `backend/src/queue/contracts.ts`
- Create: `backend/src/queue/names.ts`
- Create: `backend/src/queue/connection.ts`
- Create: `backend/src/queue/queues.ts`
- Create: `backend/src/queue/enqueue.ts`
- Modify: `backend/src/lib/embedding-queue.ts`
- Test: `backend/src/__tests__/queue-contracts.test.ts`
- Test: `backend/src/__tests__/queue-enqueue.test.ts`

**Interfaces:**
- Produces: `enqueueDocumentPipeline(input): Promise<{ generationId: string; deduplicated: boolean }>`.
- Produces deterministic job IDs: `prepare:{documentId}:{generationId}`, `embed:{generationId}:{batchIndex}`, `graph:{generationId}`, `summary:{generationId}`, `finalize:{generationId}`.
- Preserves `enqueueEmbedding(documentId): Promise<boolean>` as a one-release compatibility wrapper.

- [ ] **Step 1: Write Zod contract tests**

Reject missing `ownerId`, invalid UUIDs, unknown `source`, unknown schema version, negative batch indexes, and batches with more than the configured chunk count.

- [ ] **Step 2: Define queue names and priorities**

```ts
export const QUEUE_NAMES = {
  prepare: "hiai-docs:prepare:v1",
  embed: "hiai-docs:embed:v1",
  graph: "hiai-docs:graph:v1",
  summarize: "hiai-docs:summarize:v1",
  finalize: "hiai-docs:finalize:v1",
} as const;

export const SOURCE_PRIORITY = {
  interactive: 1,
  import: 2,
  api: 2,
  reindex: 10,
  backfill: 20,
} as const;
```

- [ ] **Step 3: Implement transactional generation creation**

Create the PostgreSQL run first, then enqueue the deterministic prepare job. If enqueue fails, leave the run pending so reconciliation can recover it.

- [ ] **Step 4: Preserve caller compatibility**

Make `backend/src/lib/embedding-queue.ts` delegate to the new facade and log a deprecation warning only in development.

- [ ] **Step 5: Test deduplication and owner isolation**

Two enqueue requests for the same document revision must return the same active generation; requests for different owners must never share a run or job ID.

- [ ] **Step 6: Verify and commit**

Run: `cd backend && bun test src/__tests__/queue-contracts.test.ts src/__tests__/queue-enqueue.test.ts && bun run typecheck`

```bash
git add backend/src/queue backend/src/lib/embedding-queue.ts backend/src/__tests__/queue-contracts.test.ts backend/src/__tests__/queue-enqueue.test.ts
git commit -m "feat(queue): add versioned document jobs"
```

---

### Task 4: Extract Prepare and Embedding Batch Workers

**Files:**
- Create: `backend/src/queue/workers/prepare.worker.ts`
- Create: `backend/src/queue/workers/embed.worker.ts`
- Modify: `backend/src/embedding/worker.ts`
- Modify: `backend/src/embedding/generation.ts`
- Test: `backend/src/__tests__/prepare-worker.test.ts`
- Test: `backend/src/__tests__/embed-worker.test.ts`

**Interfaces:**
- Prepare produces stable chunk rows and `EmbedBatchJob[]` of `EMBEDDING_BATCH_SIZE` chunks.
- Embed atomically marks a batch ready and schedules graph/finalize only when all batches for the current revision are ready.

- [ ] **Step 1: Write prepare idempotency tests**

Running prepare twice for the same generation must create the same chunk plan and no duplicate batch rows.

- [ ] **Step 2: Split pure preparation from the legacy worker**

Move document loading, owner validation, metadata preamble, chunk calculation, chunk hashes, and generation initialization into a reusable `prepareDocumentGeneration()` function.

- [ ] **Step 3: Add batch fan-out with fairness**

Create batches of five chunks by default. Add no more than `QUEUE_MAX_ACTIVE_BATCHES_PER_DOCUMENT` unfinished batches to BullMQ at a time; completion enqueues the next batch window. This prevents a 2,000-page PDF from occupying the entire ready queue.

- [ ] **Step 4: Write embedding idempotency tests**

Retrying an already completed batch must return success without a provider request. A stale revision must be marked cancelled without writing embeddings.

- [ ] **Step 5: Implement revision fencing**

Before provider invocation and before commit, compare job `revision` with the current document content hash. Never activate an obsolete generation.

- [ ] **Step 6: Activate semantic search before GraphRAG**

When all embedding batches are valid, call `activateEmbeddingGeneration()` and mark `embeddingStatus=ready` before adding graph and summary jobs.

- [ ] **Step 7: Verify and commit**

Run: `cd backend && bun test src/__tests__/prepare-worker.test.ts src/__tests__/embed-worker.test.ts src/__tests__/embedding-generation.test.ts && bun run typecheck`

```bash
git add backend/src/queue/workers/prepare.worker.ts backend/src/queue/workers/embed.worker.ts backend/src/embedding/worker.ts backend/src/embedding/generation.ts backend/src/__tests__/prepare-worker.test.ts backend/src/__tests__/embed-worker.test.ts
git commit -m "feat(queue): parallelize embedding batches"
```

---

### Task 5: Isolate Graph, Summary, and Finalize Workers

**Files:**
- Create: `backend/src/queue/workers/graph.worker.ts`
- Create: `backend/src/queue/workers/summarize.worker.ts`
- Create: `backend/src/queue/workers/finalize.worker.ts`
- Modify: `backend/src/lib/graph/extract-entities.ts`
- Test: `backend/src/__tests__/graph-worker.test.ts`
- Test: `backend/src/__tests__/finalize-worker.test.ts`

**Interfaces:**
- Graph consumes an active embedding generation and produces graph entities/relations for the same owner and generation.
- Summary is optional and may be skipped without failing graph or embeddings.
- Finalize derives the terminal run status from independent stage states.

- [ ] **Step 1: Write graph isolation tests**

A graph timeout must set `graphStatus=retrying/failed` while leaving `embeddingStatus=ready` and active vectors queryable.

- [ ] **Step 2: Implement idempotent graph writes**

Delete/replace only graph records owned by the same document generation, or use generation-scoped entity/relation fingerprints. A retry must not duplicate AGE vertices or edges.

- [ ] **Step 3: Implement optional summary**

If summarization is disabled, mark the stage `skipped` and enqueue finalize. Do not couple summary configuration to GraphRAG extraction configuration.

- [ ] **Step 4: Implement finalize semantics**

Use these terminal rules:

```text
embedding failed  -> run failed
embedding ready + graph failed -> run ready_with_warnings
embedding ready + graph ready/skipped + summary ready/skipped -> run ready
stale revision -> run cancelled
```

Add `ready_with_warnings` to the run-status enum if required; do not overload document `embeddingStatus`.

- [ ] **Step 5: Verify and commit**

Run: `cd backend && bun test src/__tests__/graph-worker.test.ts src/__tests__/finalize-worker.test.ts && bun run typecheck`

```bash
git add backend/src/queue/workers/graph.worker.ts backend/src/queue/workers/summarize.worker.ts backend/src/queue/workers/finalize.worker.ts backend/src/lib/graph/extract-entities.ts backend/src/__tests__/graph-worker.test.ts backend/src/__tests__/finalize-worker.test.ts
git commit -m "feat(queue): isolate GraphRAG stages"
```

---

### Task 6: Add Multi-User Fairness Without Product Quotas

**Files:**
- Create: `backend/src/queue/fair-scheduler.ts`
- Create: `backend/src/queue/provider-limiter.ts`
- Modify: `backend/src/queue/workers/embed.worker.ts`
- Modify: `backend/src/queue/workers/graph.worker.ts`
- Test: `backend/src/__tests__/queue-fairness.test.ts`
- Test: `backend/src/__tests__/provider-limiter.test.ts`

**Interfaces:**
- Produces `acquireOwnerSlot(ownerId, stage, signal): Promise<Release>`.
- Produces `withProviderPermit(profile, operation, fn)` with limiter mode `disabled | local | remote`.

- [ ] **Step 1: Write a starvation test**

Queue 100 batches for owner A and one batch for owner B. Assert B starts before A completes more than `QUEUE_MAX_ACTIVE_BATCHES_PER_OWNER` batches.

- [ ] **Step 2: Implement owner-aware semaphores**

Use Redis atomic counters with expirations and unique lease IDs. Defaults:

```text
QUEUE_MAX_ACTIVE_PREPARE_PER_OWNER=2
QUEUE_MAX_ACTIVE_EMBED_PER_OWNER=4
QUEUE_MAX_ACTIVE_GRAPH_PER_OWNER=1
QUEUE_MAX_ACTIVE_BATCHES_PER_DOCUMENT=2
```

These are fairness controls, not submission quotas: queued work is never rejected merely because the owner has many documents.

- [ ] **Step 3: Implement provider profiles**

```ts
export type ProviderLimiterMode = "disabled" | "local" | "remote";
```

- `disabled`: no RPM/token limiter; worker concurrency is the only bound.
- `local`: no API quota; optional concurrency cap protects GPU memory.
- `remote`: configurable concurrency, requests/minute, exponential backoff, and `Retry-After` handling.

- [ ] **Step 4: Ensure API calls have no artificial local quota**

Do not reject document imports because of queue depth or per-owner counts. Return `202/201` with pipeline identifiers and expose progress. Apply only existing authentication, payload-size, and database-safety validation.

- [ ] **Step 5: Verify and commit**

Run: `cd backend && bun test src/__tests__/queue-fairness.test.ts src/__tests__/provider-limiter.test.ts`

```bash
git add backend/src/queue/fair-scheduler.ts backend/src/queue/provider-limiter.ts backend/src/queue/workers/embed.worker.ts backend/src/queue/workers/graph.worker.ts backend/src/__tests__/queue-fairness.test.ts backend/src/__tests__/provider-limiter.test.ts
git commit -m "feat(queue): schedule fairly across owners"
```

---

### Task 7: Add Retry, Circuit Breaker, Recovery, and Dead-Letter Semantics

**Files:**
- Create: `backend/src/queue/recovery.ts`
- Create: `backend/src/scripts/recover-pipeline.ts`
- Modify: `backend/src/queue/names.ts`
- Modify: `backend/src/queue/provider-limiter.ts`
- Test: `backend/src/__tests__/queue-recovery.test.ts`
- Test: `backend/src/__tests__/queue-failure.test.ts`

**Interfaces:**
- Produces `recoverIncompletePipelineRuns(): Promise<RecoveryReport>`.
- Produces stage-specific retry policies and a provider circuit state independent for embedding primary/fallback and graph primary/fallback.

- [ ] **Step 1: Classify errors**

Retry `408`, `429`, `500`, `502`, `503`, `504`, connection reset, and timeout. Do not retry invalid input, unsupported content, invalid embedding dimensions, owner mismatch, or stale revision.

- [ ] **Step 2: Configure stage retries**

```ts
const retry = {
  prepare: { attempts: 3, delay: 1_000 },
  embed: { attempts: 4, delay: 5_000 },
  graph: { attempts: 4, delay: 5_000 },
  summarize: { attempts: 3, delay: 5_000 },
  finalize: { attempts: 5, delay: 1_000 },
};
```

Use exponential backoff with jitter in the processor; respect a bounded `Retry-After` response.

- [ ] **Step 3: Add circuit breaker tests**

After the configured consecutive failures, jobs must be moved to delayed state without occupying workers until cooldown expires. Primary and fallback circuits must be independent.

- [ ] **Step 4: Reconcile from PostgreSQL at startup**

Recover `pending`, expired `processing`, and `retrying` stages using deterministic job IDs. Do not requeue `cancelled`, terminal `ready`, or current healthy active jobs.

- [ ] **Step 5: Add operator recovery command**

Run: `cd backend && bun run pipeline:recover --dry-run`

Output counts by stage, owner, age, and intended action without printing document content or secrets.

- [ ] **Step 6: Verify and commit**

```bash
git add backend/src/queue/recovery.ts backend/src/scripts/recover-pipeline.ts backend/src/queue/names.ts backend/src/queue/provider-limiter.ts backend/src/__tests__/queue-recovery.test.ts backend/src/__tests__/queue-failure.test.ts backend/package.json
git commit -m "feat(queue): recover durable pipeline jobs"
```

---

### Task 8: Start Workers Safely and Remove the Legacy BRPOP Loop

**Files:**
- Create: `backend/src/queue/start.ts`
- Modify: `backend/src/index.ts`
- Modify: `backend/src/lib/embedding-queue.ts`
- Modify: `backend/src/embedding/worker.ts`
- Test: `backend/src/__tests__/queue-lifecycle.test.ts`

**Interfaces:**
- Produces `startPipelineWorkers(): Promise<PipelineRuntime>`.
- `PipelineRuntime.close(): Promise<void>` pauses intake, drains active jobs within grace time, closes QueueEvents/Workers/Queues, then Redis connections.

- [ ] **Step 1: Write lifecycle tests**

Assert startup recovery runs before workers accept new jobs, SIGTERM stops new work, active work receives a grace period, and repeated `close()` calls are safe.

- [ ] **Step 2: Start independent workers**

Instantiate one Worker per stage with configuration-derived concurrency. A graph worker crash must not close embed workers.

- [ ] **Step 3: Remove legacy Redis list consumption**

Delete the `while(true) + BRPOP` loop only after every producer uses the enqueue facade and recovery tests pass.

- [ ] **Step 4: Add one-release migration bridge**

At startup, drain legacy `hiai-docs:embedding-queue` IDs into prepare jobs with source `backfill`, deduplicated by current document revision. Remove the bridge in the next minor release.

- [ ] **Step 5: Verify and commit**

Run: `cd backend && bun test src/__tests__/queue-lifecycle.test.ts && bun run typecheck`

```bash
git add backend/src/queue/start.ts backend/src/index.ts backend/src/lib/embedding-queue.ts backend/src/embedding/worker.ts backend/src/__tests__/queue-lifecycle.test.ts
git commit -m "refactor(queue): replace embedding list worker"
```

---

### Task 9: Update Every Producer and Expose Pipeline Progress

**Files:**
- Modify: `backend/src/api/routes/documents.ts`
- Modify: `backend/src/api/routes/versions.ts`
- Modify: `backend/src/api/routes/admin.ts`
- Modify: `backend/src/lib/reembed.ts`
- Create: `backend/src/api/routes/pipeline.ts`
- Test: `backend/src/__tests__/pipeline-routes.test.ts`
- Test: `backend/tests/integration/pipeline-import.test.ts`

**Interfaces:**
- Produces `GET /api/documents/:id/pipeline` scoped to the authenticated owner.
- Import/create/update responses include `pipelineRunId`, `generationId`, and initial `pipelineStatus` without waiting for models.

- [ ] **Step 1: Add route authorization tests**

Owner A must never read owner B's run, progress, error, model, batch counts, or queue metadata. Share links do not expose private pipeline internals.

- [ ] **Step 2: Map producer sources and priorities**

```text
editor save/create -> interactive
file import -> import
API-key create/import/update -> api
admin reindex -> reindex
migration/recovery -> backfill
metadata reembed -> interactive for direct user action, reindex for bulk admin action
```

- [ ] **Step 3: Return non-blocking progress identifiers**

Preserve existing success status compatibility while adding pipeline fields. Do not make HTTP requests wait for embeddings or GraphRAG.

- [ ] **Step 4: Add end-to-end ordinary import test**

Without manual reindex, assert:

```text
import accepted
prepare completed
more than one batch can run concurrently
active embedding generation contains only valid 1024-dimensional vectors
semantic search works before or independently of graph completion
graph reaches ready/skipped/failed without changing embedding ready
```

- [ ] **Step 5: Verify and commit**

```bash
git add backend/src/api/routes/documents.ts backend/src/api/routes/versions.ts backend/src/api/routes/admin.ts backend/src/lib/reembed.ts backend/src/api/routes/pipeline.ts backend/src/__tests__/pipeline-routes.test.ts backend/tests/integration/pipeline-import.test.ts
git commit -m "feat(api): expose document pipeline progress"
```

---

### Task 10: Add Metrics, Queue Health, and Load Gates

**Files:**
- Modify: `backend/src/lib/metrics.ts`
- Modify: `backend/src/api/routes/metrics.ts`
- Create: `backend/src/queue/health.ts`
- Create: `backend/src/scripts/benchmark-pipeline.ts`
- Test: `backend/src/__tests__/queue-metrics.test.ts`
- Test: `backend/tests/integration/pipeline-load.test.ts`

**Interfaces:**
- Produces fixed-cardinality metrics per stage, never labeled by owner/document IDs.
- Produces a benchmark report with throughput, queue wait p50/p95, processing p50/p95, failure rate, fairness, and provider calls.

- [ ] **Step 1: Add fixed metrics**

```text
pipeline_<stage>_waiting
pipeline_<stage>_active
pipeline_<stage>_delayed
pipeline_<stage>_completed_total
pipeline_<stage>_failed_total
pipeline_<stage>_retried_total
pipeline_<stage>_wait_ms
pipeline_<stage>_duration_ms
pipeline_oldest_waiting_ms
pipeline_recovered_total
pipeline_stale_cancelled_total
```

- [ ] **Step 2: Define health semantics**

API health remains healthy when optional graph providers are down but reports `degraded.graph`. Mark queue unhealthy only when Redis is unavailable, recovery cannot persist, or the oldest interactive job exceeds the configured SLO.

- [ ] **Step 3: Add multi-user load test**

Generate at least 10 owners, 20 documents per owner, mixed small/large documents, interactive jobs during backfill, and injected provider delays. Assert no cross-owner reads/writes and no starvation.

- [ ] **Step 4: Add acceptance gates**

Initial local gates:

```text
0 tenant leakage
0 lost jobs after worker restart
0 duplicate active generations
100% active embeddings have 1024 dimensions
interactive job starts before bulk owner drains its queue
semantic search available when graph provider is unavailable
```

Record throughput and p95 as a baseline rather than inventing a hardware-independent absolute limit.

- [ ] **Step 5: Verify and commit**

```bash
git add backend/src/lib/metrics.ts backend/src/api/routes/metrics.ts backend/src/queue/health.ts backend/src/scripts/benchmark-pipeline.ts backend/src/__tests__/queue-metrics.test.ts backend/tests/integration/pipeline-load.test.ts backend/package.json
git commit -m "test(queue): gate multi-user pipeline load"
```

---

### Task 11: Configure Docker and Document Local Ollama Tuning

**Files:**
- Modify: `backend/src/lib/config-schema.ts`
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `README.md`
- Test: `backend/src/__tests__/config.test.ts`
- Test: `backend/src/__tests__/ollama-queue-profile.test.ts`

**Interfaces:**
- Produces validated queue configuration and a documented local Ollama profile.
- Does not add Ollama as a mandatory Compose service; users point hiai-docs to their existing Ollama endpoint.

- [ ] **Step 1: Add configuration tests**

Validate positive concurrency, bounded retention, valid limiter modes, graph concurrency independent from embed concurrency, and refusal of negative/NaN values.

- [ ] **Step 2: Add environment variables**

```dotenv
QUEUE_PREPARE_CONCURRENCY=2
QUEUE_EMBED_CONCURRENCY=3
QUEUE_GRAPH_CONCURRENCY=2
QUEUE_SUMMARY_CONCURRENCY=1
QUEUE_FINALIZE_CONCURRENCY=2
QUEUE_EMBED_BATCH_SIZE=5
QUEUE_MAX_ACTIVE_BATCHES_PER_DOCUMENT=2
QUEUE_MAX_ACTIVE_PREPARE_PER_OWNER=2
QUEUE_MAX_ACTIVE_EMBED_PER_OWNER=4
QUEUE_MAX_ACTIVE_GRAPH_PER_OWNER=1
QUEUE_COMPLETED_RETENTION_COUNT=1000
QUEUE_FAILED_RETENTION_COUNT=5000
QUEUE_SHUTDOWN_GRACE_MS=30000
PROVIDER_LIMITER_MODE=remote
PROVIDER_MAX_CONCURRENCY=3
PROVIDER_REQUESTS_PER_MINUTE=0
PROVIDER_CIRCUIT_FAILURE_THRESHOLD=5
PROVIDER_CIRCUIT_COOLDOWN_MS=30000
```

`PROVIDER_REQUESTS_PER_MINUTE=0` means unlimited, not disabled processing.

- [ ] **Step 3: Document the local Ollama profile**

Add a dedicated “Local Ollama queue tuning” section to `docs/DEPLOYMENT.md`:

```dotenv
EMBEDDING_BASE_URL=http://host.docker.internal:11434/v1
EMBEDDING_API_KEY=ollama
EMBEDDING_MODEL=<installed-embedding-model>
GRAPH_EXTRACT_BASE_URL=http://host.docker.internal:11434/v1
GRAPH_EXTRACT_API_KEY=ollama
GRAPH_EXTRACT_MODEL=<installed-chat-model>
PROVIDER_LIMITER_MODE=local
PROVIDER_REQUESTS_PER_MINUTE=0
```

Document only the knobs operators should change:

```text
GPU OOM -> lower QUEUE_EMBED_CONCURRENCY and QUEUE_GRAPH_CONCURRENCY
GPU underutilized -> raise one concurrency value at a time
large VRAM + parallel runner -> raise QUEUE_EMBED_CONCURRENCY
single-model Ollama swapping -> keep graph concurrency 1
remote OpenRouter -> use limiter mode remote and provider-specific limits
```

Do not claim universal concurrency values for unknown GPUs. Explain how to observe queue wait, provider latency, GPU memory, and error rate before changing settings.

- [ ] **Step 4: Document API behavior**

State clearly that hiai-docs does not apply document/job quotas for local API usage. Requests are accepted and queued; authentication, payload limits, database constraints, and infrastructure backpressure still apply.

- [ ] **Step 5: Add Compose worker health checks**

Keep one API image if workers run in-process for the first release. Document the later option to run stage workers as separate Compose services using the same image and stage selector.

- [ ] **Step 6: Verify docs and configuration**

Run:

```bash
cd backend && bun test src/__tests__/config.test.ts src/__tests__/ollama-queue-profile.test.ts
cd .. && docker compose config --quiet
```

Expected: tests and Compose validation pass with default and Ollama profiles.

- [ ] **Step 7: Commit**

```bash
git add backend/src/lib/config-schema.ts backend/src/__tests__/config.test.ts backend/src/__tests__/ollama-queue-profile.test.ts .env.example docker-compose.yml docs/DEPLOYMENT.md docs/ARCHITECTURE.md README.md
git commit -m "docs(queue): configure BullMQ and Ollama"
```

---

### Task 12: Migration, Rollback, and Release Verification

**Files:**
- Create: `backend/tests/integration/legacy-queue-migration.test.ts`
- Create: `backend/tests/integration/pipeline-restart.test.ts`
- Modify: `docs/PRODUCTION_STATUS.md`
- Modify: `RELEASE_CHECKLIST.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces a one-release migration path from the Redis list and a rollback procedure that preserves PostgreSQL run state.

- [ ] **Step 1: Test legacy queue migration**

Seed old string and retry-envelope jobs in `hiai-docs:embedding-queue`, start the new runtime, and assert each current document revision becomes exactly one prepare job.

- [ ] **Step 2: Test crash recovery**

Terminate workers during prepare, embed, graph, and finalize. Restart and assert no lost jobs, no duplicate active generations, and correct owner isolation.

- [ ] **Step 3: Test Redis loss recovery**

Flush only the isolated test Redis database, keep PostgreSQL, run reconciliation, and assert all nonterminal runs are recreated with deterministic job IDs.

- [ ] **Step 4: Define rollback**

Rollback pauses BullMQ producers/workers, preserves pipeline tables, and runs a compatibility script that enqueues current nonterminal document IDs into the legacy list. Never roll back database state by deleting generation records.

- [ ] **Step 5: Run the full release matrix**

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run --filter '*' build
docker compose config --quiet
docker compose build api web
```

Then run fresh-volume and upgraded-volume integration tests, ordinary UI import, API import, multi-user load, provider outage, worker restart, and Ollama profile smoke.

- [ ] **Step 6: Update release documentation**

Record BullMQ as the job executor, PostgreSQL as recovery truth, the legacy bridge removal target, measured benchmark results, and remaining limitations.

- [ ] **Step 7: Commit**

```bash
git add backend/tests/integration/legacy-queue-migration.test.ts backend/tests/integration/pipeline-restart.test.ts docs/PRODUCTION_STATUS.md RELEASE_CHECKLIST.md CHANGELOG.md
git commit -m "test(queue): verify BullMQ migration and recovery"
```

---

## Parallel Execution Waves

### Wave 0 — sequential prerequisite

- Task 1: Bun/BullMQ compatibility smoke.
- Task 2: PostgreSQL pipeline schema.

Task 1 must pass before implementation commits depend on BullMQ. Task 2 must land before workers persist state.

### Wave 1 — parallel after Tasks 1–2

- Lane A: Task 3 — contracts, queues, enqueue facade.
- Lane B: Task 5 test scaffolding — graph/finalize failure semantics against the new schema.
- Lane C: Task 10 metric-name and benchmark harness scaffolding.
- Lane D: Task 11 documentation/config tests, excluding final values that depend on implementation.

### Wave 2 — partially parallel

- Task 4 prepare/embed workers depends on Task 3.
- Task 6 fairness/limiter can start after Task 3 contracts stabilize.
- Task 7 recovery can start after Task 3 and Task 2.
- Task 5 implementation depends on Task 4's generation completion contract.

### Wave 3 — integration convergence

- Task 8 lifecycle and legacy bridge depends on Tasks 4, 5, and 7.
- Task 9 producer migration depends on Tasks 3 and 8.
- Task 10 full load gates depend on Tasks 4–9.
- Task 11 final Compose/docs depend on measured Task 10 behavior.

### Wave 4 — sequential release gate

- Task 12 migration, restart, fresh/upgraded DB, Docker, and Ollama verification.

Do not merge simultaneous edits to `backend/src/lib/config-schema.ts`, `backend/src/lib/metrics.ts`, `backend/src/embedding/worker.ts`, `packages/db/src/schema.ts`, `.env.example`, or `docker-compose.yml`. Assign one owner per shared file and use interface contracts for other lanes.

## Acceptance Definition

The implementation is complete only when all of the following are demonstrated without manual reindex:

1. Ordinary UI and API imports automatically enter the prepare queue.
2. Multiple documents and owners progress concurrently.
3. A slow graph request does not block embeddings for other documents.
4. A large document cannot starve a small interactive document.
5. All active embeddings are valid 1024-dimensional vectors.
6. Semantic search works once embeddings are ready, even if graph extraction is delayed or failed.
7. Worker and Redis restarts lose no nonterminal work.
8. Retries do not duplicate chunks, graph records, or active generations.
9. No cross-owner data appears in jobs, progress endpoints, logs, or results.
10. Local Ollama works with provider RPM limiting disabled and only worker concurrency protecting hardware.
11. Remote-provider rate limits remain configurable without changing code.
12. Fresh and upgraded PostgreSQL installations, Docker images, lint, typecheck, tests, and builds pass.

