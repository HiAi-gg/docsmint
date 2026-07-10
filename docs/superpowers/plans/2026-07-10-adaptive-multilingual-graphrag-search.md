# Adaptive Multilingual GraphRAG Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current literal English-weighted hybrid search with a reliable multilingual, typo-tolerant, automatically GraphRAG-enhanced search that validates every embedding and expands only uncertain queries.

**Architecture:** Add a domain-owned `backend/src/search/` module between the HTTP route and the existing embedding, PostgreSQL, and AGE adapters. Retrieval channels return ranked candidates to an RRF fusion layer; a deterministic confidence gate decides whether a single structured LLM expansion pass is needed. Embeddings become generation-aware so a replacement index is validated completely before it atomically becomes active.

**Tech Stack:** Bun 1.3.14+, TypeScript strict ESM, Elysia 1.4.28+, Drizzle ORM 0.45.2+, PostgreSQL 18.4, pgvector, pg_trgm, Apache AGE, Redis 8.6+, SvelteKit 2.60+, Svelte 5.55+, Zod 4.

## Global Constraints

- Preserve Bun-native ESM; do not add Node-only runtime glue, npm, yarn, CommonJS, Playwright, or a second AI orchestration framework.
- Keep GraphRAG embedded in hiai-docs; do not introduce Mastra into hiai-docs.
- Keep all environment access in `backend/src/lib/config.ts` through `backend/src/lib/config-schema.ts`.
- Keep code, comments, docs, fixtures, and public UI copy in English.
- Keep every retrieval query owner-scoped or share-scope-scoped before candidates enter fusion.
- Keep the OpenRouter key in local/deployment secret state; public files contain only the existing change-me placeholder.
- Use 1024-dimensional embeddings for primary `openai/text-embedding-3-small` and fallback `baai/bge-m3`.
- Use `mistralai/ministral-14b-2512` for query expansion and `google/gemma-4-31b-it` as its fallback.
- Run GraphRAG automatically for normal search when the graph subsystem is healthy; do not require a frontend `graph=true` parameter.
- Run at most one LLM expansion pass per request and return fast-pass results if expansion or GraphRAG fails.
- Use RRF for cross-channel fusion; do not combine raw lexical and vector scores with the legacy 0.4/0.6 formula.
- Exclude zero, non-finite, wrong-dimension, stale, inactive-generation, and below-threshold vectors from retrieval.
- Before implementation writes, run `scripts/prework_backup.sh hiai-docs`; stop if it fails.
- Push requires a separate explicit authorization.

## File and Module Map

### Database and indexing

- `packages/db/src/migrations/0025_search_embedding_generations.sql` — add embedding lifecycle and generation metadata plus multilingual search vectors.
- `packages/db/src/migrations/meta/_journal.json` — register migration 0025.
- `packages/db/src/schema.ts` — expose lifecycle columns, generation-aware uniqueness, fixed vector dimension, and simple-language search vector.
- `backend/src/embedding/result.ts` — define validated provider result and failure codes.
- `backend/src/embedding/validation.ts` — finite/non-zero/1024-dimensional vector validation and profile hashing.
- `backend/src/embedding/index.ts` — return validated primary/fallback results instead of zero-vector success values.
- `backend/src/embedding/worker.ts` — stage, validate, and atomically activate embedding generations; trigger graph extraction only after activation.
- `backend/src/embedding/incremental.ts` — compare chunks inside the active generation.
- `backend/src/scripts/reindex-embeddings.ts` — resumable stale/invalid generation reindex command.

### Search domain

- `backend/src/search/types.ts` — shared query, candidate, evidence, result, diagnostics, and adapter contracts.
- `backend/src/search/query-analyzer.ts` — Unicode-safe normalization and lightweight language detection.
- `backend/src/search/confidence.ts` — deterministic expansion decision and reason codes.
- `backend/src/search/rrf.ts` — fusion, exact/agreement boosts, graph cap, and document deduplication.
- `backend/src/search/retrievers.ts` — exact/title, multilingual FTS, trigram, and active-generation vector adapters.
- `backend/src/search/query-expander.ts` — one-pass structured LLM query plan expansion with Redis caching.
- `backend/src/search/graph-retriever.ts` — bounded automatic AGE expansion as a ranked channel.
- `backend/src/search/orchestrator.ts` — parallel fast pass, confidence gate, optional expansion, GraphRAG, fusion, filters, and pagination.
- `backend/src/lib/openai-compatible-chat.ts` — shared provider/fallback JSON chat transport used by graph extraction and query expansion.
- `backend/src/api/routes/search.ts` — HTTP validation and response serialization only.

### API, UI, metrics, and evaluation

- `backend/src/lib/config-schema.ts` and `.env.example` — search thresholds, RRF, expansion model, timeout, cache, and vector threshold configuration.
- `backend/src/lib/metrics.ts` and `backend/src/api/routes/metrics.ts` — bounded search counters/histograms and embedding-state inventory.
- `backend/src/api/routes/admin.ts` — generation-aware embedding health and reindex reporting.
- `frontend/src/lib/api/search.ts` — result explanations and diagnostics types; remove the client graph-switch concept.
- `frontend/src/lib/components/SearchResult.svelte` — render concise search-match explanations.
- `frontend/src/routes/(app)/search/+page.svelte` — retain the single search input and consume explanations.
- `backend/tests/fixtures/search-relevance.json` — versioned multilingual, typo, thematic, exact, graph, negative, and tenant-isolation judgments.
- `backend/src/scripts/benchmark-search.ts` — calculate Recall@10, MRR@10, p95 latency, expansion rate, and leakage.
- `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`, `README.md`, `AGENTS.md` — replace the legacy opt-in/weighted-search documentation.

---

### Task 1: Add Generation-Aware Embedding and Multilingual Search Schema

**Files:**
- Create: `packages/db/src/migrations/0025_search_embedding_generations.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`
- Modify: `packages/db/src/schema.ts:147-193,416-456`
- Create: `packages/db/src/search-embedding-schema.test.ts`

**Interfaces:**
- Produces document fields `embeddingStatus`, `activeEmbeddingGeneration`, `pendingEmbeddingGeneration`, `embeddingProfile`, `embeddingErrorCode`, and `embeddingUpdatedAt`.
- Produces embedding fields `generationId`, `embeddingDimensions`, `embeddingProfile`, and `isValid`.
- Produces `documents.search_vector_simple` for language-neutral lexical matching.
- Preserves the existing `documents.search_vector` English stemmed index for English recall.

- [ ] **Step 1: Write the failing schema contract test**

```ts
import { describe, expect, test } from "bun:test";
import { documentEmbeddings, documents } from "./schema";

describe("search embedding schema", () => {
  test("exports lifecycle and generation columns", () => {
    expect(documents.embeddingStatus.name).toBe("embedding_status");
    expect(documents.activeEmbeddingGeneration.name).toBe("active_embedding_generation");
    expect(documentEmbeddings.generationId.name).toBe("generation_id");
    expect(documentEmbeddings.embeddingDimensions.name).toBe("embedding_dimensions");
    expect(documentEmbeddings.isValid.name).toBe("is_valid");
  });

  test("exports the language-neutral vector", () => {
    expect(documents.searchVectorSimple.name).toBe("search_vector_simple");
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `cd packages/db && bun test src/search-embedding-schema.test.ts`

Expected: FAIL because the lifecycle and simple-vector properties do not exist.

- [ ] **Step 3: Add the Drizzle schema fields**

Add a `pgEnum` named `embedding_status` with `pending`, `processing`, `ready`, `failed`, and `stale`. Define the generated vector exactly as:

```ts
searchVectorSimple: tsvector("search_vector_simple").generatedAlwaysAs(
  sql`to_tsvector('simple', COALESCE(title, '') || ' ' || COALESCE(content, ''))`
),
embeddingStatus: embeddingStatusEnum("embedding_status").notNull().default("pending"),
activeEmbeddingGeneration: uuid("active_embedding_generation"),
pendingEmbeddingGeneration: uuid("pending_embedding_generation"),
embeddingProfile: text("embedding_profile"),
embeddingErrorCode: text("embedding_error_code"),
embeddingUpdatedAt: timestamp("embedding_updated_at"),
```

Define the embedding vector as `vector("embedding", { dimensions: 1024 })` and add:

```ts
generationId: uuid("generation_id").notNull(),
embeddingDimensions: integer("embedding_dimensions").notNull().default(1024),
embeddingProfile: text("embedding_profile").notNull().default("legacy"),
isValid: boolean("is_valid").notNull().default(false),
```

Replace `document_embeddings_doc_chunk_idx` with a unique index over `(documentId, generationId, chunkIndex)`. Add indexes on `(documentId, generationId, isValid)` and `documents.embeddingStatus`.

- [ ] **Step 4: Write migration 0025 with safe legacy backfill**

The migration must:

1. create `embedding_status`;
2. add the document and embedding columns as nullable;
3. assign one generated UUID per legacy document embedding set;
4. mark a legacy row valid only when `vector_dims(embedding) = 1024`, `vector_norm(embedding) > 0`, and `embedding_model <> ''`;
5. set each document active generation and `ready` only when every row in that generation is valid; otherwise set `stale`;
6. apply NOT NULL/default constraints after backfill;
7. replace the old two-column unique index;
8. add the simple generated tsvector and GIN index;
9. preserve the existing HNSW and StreamingDiskANN indexes.

Use a per-document generation CTE, not `gen_random_uuid()` directly in a row-wise update:

```sql
WITH generations AS (
  SELECT document_id, gen_random_uuid() AS generation_id
  FROM (SELECT DISTINCT document_id FROM document_embeddings) AS legacy_documents
)
UPDATE document_embeddings AS de
SET generation_id = g.generation_id
FROM generations AS g
WHERE g.document_id = de.document_id;
```

- [ ] **Step 5: Register the migration and test fresh plus upgraded databases**

Run: `cd packages/db && bun run db:migrate`

Expected: migration 0025 succeeds on the existing database.

Run against a fresh disposable database through the project migration runner and verify:

```sql
SELECT enumlabel FROM pg_enum
JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
WHERE pg_type.typname = 'embedding_status'
ORDER BY enumsortorder;

SELECT vector_dims(embedding), is_valid, generation_id
FROM document_embeddings
LIMIT 1;
```

Expected: five ordered states; embedding rows expose dimension, validity, and generation.

- [ ] **Step 6: Run checks and commit**

Run: `cd packages/db && bun test src/search-embedding-schema.test.ts && bun run typecheck`

Expected: PASS.

```bash
git add packages/db/src/schema.ts packages/db/src/search-embedding-schema.test.ts packages/db/src/migrations/0025_search_embedding_generations.sql packages/db/src/migrations/meta/_journal.json
git commit -m "feat(db): add embedding generation lifecycle"
```

### Task 2: Make Embedding Provider Outcomes Explicit and Validated

**Files:**
- Create: `backend/src/embedding/result.ts`
- Create: `backend/src/embedding/validation.ts`
- Create: `backend/src/__tests__/embedding-validation.test.ts`
- Modify: `backend/src/embedding/index.ts:13-113,157-220`
- Modify: `backend/src/__tests__/embedding.test.ts`
- Modify: `backend/src/__tests__/openai-compatible-embedding.test.ts`

**Interfaces:**
- Produces `EmbeddingResult`, `EmbeddingFailureCode`, `validateEmbeddingVector()`, and `embeddingProfileId()`.
- Changes `getEmbedding(text)` to `Promise<EmbeddingResult>`.
- Changes `EmbeddingChunk` to include `model`, `profile`, and `dimensions`.
- A provider failure is data, not a fabricated zero-vector success.

- [ ] **Step 1: Write validation tests**

```ts
import { describe, expect, test } from "bun:test";
import { embeddingProfileId, validateEmbeddingVector } from "../embedding/validation";

describe("embedding validation", () => {
  test("accepts exactly 1024 finite non-zero values", () => {
    expect(validateEmbeddingVector(Array(1024).fill(0.01))).toEqual({ ok: true, dimensions: 1024 });
  });

  test.each([
    [Array(1024).fill(0), "zero_vector"],
    [Array(1023).fill(0.01), "wrong_dimensions"],
    [[...Array(1023).fill(0.01), Number.NaN], "non_finite"],
  ])("rejects invalid vectors", (vector, code) => {
    expect(validateEmbeddingVector(vector)).toEqual({ ok: false, code });
  });

  test("profiles include model, dimension, and normalization version", () => {
    expect(embeddingProfileId("openai/text-embedding-3-small", 1024, "v1"))
      .toBe("openai/text-embedding-3-small:1024:v1");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd backend && bun test src/__tests__/embedding-validation.test.ts`

Expected: FAIL because `embedding/validation.ts` does not exist.

- [ ] **Step 3: Define the result contract**

```ts
export type EmbeddingFailureCode =
  | "not_configured"
  | "provider_error"
  | "zero_vector"
  | "wrong_dimensions"
  | "non_finite";

export type EmbeddingResult =
  | { ok: true; vector: number[]; model: string; provider: "primary" | "fallback"; dimensions: 1024; profile: string }
  | { ok: false; code: EmbeddingFailureCode; primaryError?: string; fallbackError?: string };
```

Implement validation with `vector.length === 1024`, `Number.isFinite`, and `vector.some(value => value !== 0)`.

- [ ] **Step 4: Refactor primary/fallback provider handling**

Validate the primary response before declaring success. Attempt fallback after either transport failure or validation failure. Return `{ ok: false }` after both fail. Never return `new Array(1024).fill(0)`.

Update `embedDocument()` so any failed chunk throws an `EmbeddingBatchError` containing only the safe failure code and chunk index. Return chunks only when every vector is valid.

- [ ] **Step 5: Update existing tests and metrics expectations**

Assert primary success, fallback success, primary invalid/fallback valid, and both-invalid failure. Preserve counters but rename `EMBEDDING_ZERO` to `EMBEDDING_INVALID` in Task 9; until then increment the existing zero counter for invalid final results to keep tests green between commits.

- [ ] **Step 6: Run checks and commit**

Run: `cd backend && bun test src/__tests__/embedding-validation.test.ts src/__tests__/embedding.test.ts src/__tests__/openai-compatible-embedding.test.ts && bun run typecheck`

Expected: PASS with no zero-vector success assertion remaining.

```bash
git add backend/src/embedding backend/src/__tests__/embedding-validation.test.ts backend/src/__tests__/embedding.test.ts backend/src/__tests__/openai-compatible-embedding.test.ts
git commit -m "fix(embedding): reject invalid provider vectors"
```

### Task 3: Stage and Atomically Activate Complete Embedding Generations

**Files:**
- Modify: `backend/src/embedding/worker.ts:47-262`
- Modify: `backend/src/embedding/incremental.ts`
- Create: `backend/src/embedding/generation.ts`
- Create: `backend/src/__tests__/embedding-generation.test.ts`
- Modify: `backend/src/__tests__/embedding-incremental.test.ts`
- Modify: `backend/src/lib/embedding-queue.ts`
- Modify: `backend/src/scripts/reindex-embeddings.ts`
- Modify: `backend/src/api/routes/admin.ts:120-290`

**Interfaces:**
- Produces `beginEmbeddingGeneration(documentId, profile)`, `activateEmbeddingGeneration(documentId, generationId, expectedChunks)`, and `failEmbeddingGeneration(documentId, generationId, code)`.
- Search reads only rows whose generation equals `documents.active_embedding_generation` and whose `is_valid` is true.
- Graph extraction runs only after `activateEmbeddingGeneration()` commits.

- [ ] **Step 1: Write failing state-machine tests**

Test these exact transitions using the existing transaction harness:

```ts
expect(canTransition("pending", "processing")).toBe(true);
expect(canTransition("processing", "ready")).toBe(true);
expect(canTransition("processing", "failed")).toBe(true);
expect(canTransition("ready", "stale")).toBe(true);
expect(canTransition("failed", "ready")).toBe(false);
```

Add a transaction test where generation B has one invalid chunk and assert generation A remains active. Add a successful generation B case and assert active generation changes only after all expected chunk rows exist and are valid.

- [ ] **Step 2: Run tests and verify failure**

Run: `cd backend && bun test src/__tests__/embedding-generation.test.ts src/__tests__/embedding-incremental.test.ts`

Expected: FAIL because generation helpers are absent.

- [ ] **Step 3: Implement generation helpers**

`beginEmbeddingGeneration()` creates a UUID, sets document status to `processing`, records it as pending, and leaves the active generation untouched. `activateEmbeddingGeneration()` executes one transaction that:

1. counts staged rows for `(documentId, generationId)`;
2. rejects unless count equals `expectedChunks` and every row is valid/profile-consistent;
3. sets active generation, profile, status `ready`, clears pending/error, and stamps `embeddingUpdatedAt`;
4. deletes older inactive generations only after activation.

`failEmbeddingGeneration()` deletes the failed staged rows, sets status to `failed`, records a safe error code, and clears the pending generation. It never deletes or replaces the active generation, so direct lexical search and a profile-compatible last known-good vector generation remain available while operators can still see the failed replacement.

- [ ] **Step 4: Refactor the worker**

Generate all chunks first, begin a generation, insert valid rows with their generation in one transaction, activate, update `contentHash`, then run entity extraction. On any exception call `failEmbeddingGeneration()`.

For incremental content edits, copy unchanged valid chunks from the active generation into the pending generation and embed only affected chunks plus neighbors. This preserves incremental cost while still producing a complete candidate generation.

Update `enqueueEmbedding()` so a document with an active generation transitions to `stale` when content, metadata, model, dimension, chunking profile, or normalization profile changes; a never-embedded document remains `pending`. Add `markStaleEmbeddingProfiles(currentProfile)` and call it once before a model-targeted reindex scan. Keep the old active rows for rollback, but do not treat a profile-mismatched generation as query-compatible.

- [ ] **Step 5: Make reindex resumable**

Update `reindex-embeddings.ts` to select `failed`, `stale`, invalid, unlabelled, wrong-profile, and documents with no active generation. Use ordered ID cursor batches and print JSON progress:

```json
{"scanned":100,"queued":37,"skipped":63,"lastDocumentId":"..."}
```

Accept `--after=<uuid>`, `--batch=<n>`, and `--dry-run`. Do not delete embeddings in the script; enqueue documents and let the worker own activation.

- [ ] **Step 6: Update admin health**

Return counts for every document status plus active invalid rows, inactive generations, profile mismatches, and pending age. Keep the endpoint API-key protected.

- [ ] **Step 7: Run checks and commit**

Run: `cd backend && bun test src/__tests__/embedding-generation.test.ts src/__tests__/embedding-incremental.test.ts src/__tests__/embedding-metadata.test.ts && bun run typecheck`

Expected: PASS.

```bash
git add backend/src/embedding backend/src/__tests__/embedding-generation.test.ts backend/src/__tests__/embedding-incremental.test.ts backend/src/lib/embedding-queue.ts backend/src/scripts/reindex-embeddings.ts backend/src/api/routes/admin.ts
git commit -m "feat(embedding): atomically activate complete generations"
```

### Task 4: Add Pure Query Analysis, Confidence, and RRF Primitives

**Files:**
- Create: `backend/src/search/types.ts`
- Create: `backend/src/search/query-analyzer.ts`
- Create: `backend/src/search/confidence.ts`
- Create: `backend/src/search/rrf.ts`
- Create: `backend/src/__tests__/search-query-analyzer.test.ts`
- Create: `backend/src/__tests__/search-confidence.test.ts`
- Create: `backend/src/__tests__/search-rrf.test.ts`

**Interfaces:**
- Produces all provider-independent search domain contracts.
- This task is independent of Tasks 1-3 and may run in parallel after the file map is accepted.

- [ ] **Step 1: Define the contracts in tests**

```ts
export type SearchChannel = "exact" | "fts" | "fuzzy" | "vector" | "expanded_fts" | "expanded_fuzzy" | "expanded_vector" | "graph";
export interface QueryPlan { original: string; normalized: string; detectedLanguage: string; translations: string[]; synonyms: string[]; concepts: string[]; namedEntities: string[] }
export interface SearchCandidate { documentId: string; channel: SearchChannel; rank: number; rawScore?: number; queryVariant?: string; evidence: string }
export type ExpansionReason = "no_lexical_match" | "low_channel_agreement" | "low_vector_similarity" | "language_mismatch" | "empty_candidates";
export interface SearchExplanation { channel: SearchChannel; label: string; queryVariant?: string }
```

Test normalization of whitespace, composed/decomposed Unicode, Cyrillic, quoted phrases, paths, and `OAuth2::Token`. Detect `ru`, `en`, `mixed`, and `und` without a network call.

- [ ] **Step 2: Add confidence tests**

Assert expansion is required for every approved reason and not required when exact plus vector channels agree above the configured vector threshold. `evaluateConfidence()` returns `{ confident, reasons }` and never calls a provider.

- [ ] **Step 3: Add deterministic RRF tests**

Use `score = Σ 1 / (rrfK + rank)` with default `rrfK=60`. Test exact-title boost, two-channel agreement boost, graph-only cap, duplicate chunk collapse, minimum vector score, and deterministic document-ID tie-breaking.

- [ ] **Step 4: Implement the pure modules**

Do not import DB, Redis, config, HTTP, or embedding code. Accept all thresholds and boost values as function parameters. Keep result explanations derived from channel evidence, not model reasoning text.

- [ ] **Step 5: Run checks and commit**

Run: `cd backend && bun test src/__tests__/search-query-analyzer.test.ts src/__tests__/search-confidence.test.ts src/__tests__/search-rrf.test.ts && bun run typecheck`

Expected: PASS.

```bash
git add backend/src/search backend/src/__tests__/search-query-analyzer.test.ts backend/src/__tests__/search-confidence.test.ts backend/src/__tests__/search-rrf.test.ts
git commit -m "feat(search): add query confidence and RRF primitives"
```

### Task 5: Implement Owner-Scoped Retrieval Channels

**Files:**
- Create: `backend/src/search/retrievers.ts`
- Create: `backend/src/__tests__/search-retrievers.test.ts`
- Create: `backend/tests/integration/search-retrievers.test.ts`
- Modify: `backend/tests/integration/_harness.ts`

**Interfaces:**
- Consumes `QueryPlan`, `SearchCandidate`, active embedding generation fields, and tenant context from `@hiai-docs/db/with-tenant`.
- Produces `retrieveFastChannels(ctx, plan, options): Promise<ChannelResult[]>`.
- A `ChannelResult` contains `{ channel, candidates, durationMs, errorCode? }`.

- [ ] **Step 1: Write SQL-adapter contract tests**

Test exact title, English FTS, simple FTS, typo similarity, active valid vector, vector below threshold, inactive generation, zero vector, and another owner's identically named document.

The isolation assertion is mandatory:

```ts
expect(results.flatMap(result => result.candidates).map(candidate => candidate.documentId))
  .not.toContain(otherOwnerDocumentId);
```

- [ ] **Step 2: Run tests and verify failure**

Run: `cd backend && bun test src/__tests__/search-retrievers.test.ts tests/integration/search-retrievers.test.ts`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement exact, FTS, and fuzzy adapters**

Run adapters concurrently with `Promise.allSettled`. Exact compares normalized title, slug-equivalent title, and identifier-like title tokens. FTS unions:

```sql
websearch_to_tsquery('english', $query) against search_vector
websearch_to_tsquery('simple', $query) against search_vector_simple
```

Fuzzy uses `similarity(title, $query)` and `%`, with a configurable minimum. Every subquery includes `d.owner_id = ctx.userId`; share-scope support uses the existing tenant context/RLS path rather than removing ownership predicates.

- [ ] **Step 4: Implement vector retrieval**

Embed the normalized query once. If embedding fails, return a vector channel error without failing other channels. Join embeddings to documents with:

```sql
de.generation_id = d.active_embedding_generation
AND de.is_valid = true
AND de.embedding_dimensions = 1024
AND de.embedding_profile = d.embedding_profile
AND de.embedding_profile = $queryEmbeddingProfile
```

Reject non-finite scores in TypeScript and candidates below `SEARCH_VECTOR_MIN_SIMILARITY`. Limit chunks per document before document aggregation so one long document cannot dominate.

- [ ] **Step 5: Run checks and commit**

Run: `cd backend && bun test src/__tests__/search-retrievers.test.ts tests/integration/search-retrievers.test.ts && bun run typecheck`

Expected: PASS including cross-owner isolation.

```bash
git add backend/src/search/retrievers.ts backend/src/__tests__/search-retrievers.test.ts backend/tests/integration/search-retrievers.test.ts backend/tests/integration/_harness.ts
git commit -m "feat(search): add multilingual retrieval channels"
```

### Task 6: Add Structured One-Pass Query Expansion

**Files:**
- Create: `backend/src/lib/openai-compatible-chat.ts`
- Create: `backend/src/search/query-expander.ts`
- Create: `backend/src/__tests__/query-expander.test.ts`
- Modify: `backend/src/lib/graph/extract-entities.ts`
- Modify: `backend/src/lib/config-schema.ts:60-184`
- Modify: `backend/src/__tests__/config.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes the minimal `QueryPlan` from Task 4.
- Produces `expandQuery(plan, scope): Promise<{ plan: QueryPlan; model: string } | null>`.
- The shared chat transport accepts primary and fallback provider configs and a Zod output schema; it returns parsed JSON or a safe failure.

- [ ] **Step 1: Write failing expander tests**

Test Russian-to-English output, deduplication, original-query removal from variants, maximum array lengths, malformed JSON, primary timeout/fallback success, both-provider failure, and tenant-scoped cache keys.

Use the exact accepted payload:

```json
{"translations":["English"],"synonyms":["English language"],"concepts":["language settings"],"namedEntities":[]}
```

- [ ] **Step 2: Run tests and verify failure**

Run: `cd backend && bun test src/__tests__/query-expander.test.ts src/__tests__/config.test.ts`

Expected: FAIL because expansion config and implementation are absent.

- [ ] **Step 3: Add configuration**

Add:

```text
SEARCH_EXPANSION_ENABLED=true
SEARCH_EXPANSION_BASE_URL=https://openrouter.ai/api/v1
SEARCH_EXPANSION_MODEL=mistralai/ministral-14b-2512
SEARCH_EXPANSION_FALLBACK_BASE_URL=https://openrouter.ai/api/v1
SEARCH_EXPANSION_FALLBACK_MODEL=google/gemma-4-31b-it
SEARCH_EXPANSION_TIMEOUT_MS=2000
SEARCH_EXPANSION_CACHE_TTL_SECONDS=86400
SEARCH_EXPANSION_MAX_VARIANTS=12
SEARCH_RRF_K=60
SEARCH_EXACT_BOOST=0.02
SEARCH_CHANNEL_AGREEMENT_BOOST=0.01
SEARCH_GRAPH_MAX_CONTRIBUTION=0.03
SEARCH_VECTOR_MIN_SIMILARITY=0.35
SEARCH_FUZZY_MIN_SIMILARITY=0.25
SEARCH_MIN_CHANNEL_AGREEMENT=2
SEARCH_GRAPH_SEED_LIMIT=10
```

Provider-specific expansion keys are optional. OpenRouter URLs may reuse `OPENROUTER_API_KEY`; local/custom URLs must never inherit it.

- [ ] **Step 4: Implement shared chat transport and expander**

Use one system message requesting JSON only and one user message containing only the original query and detected locale. Validate with Zod, cap and deduplicate every list, and merge into a new immutable plan. Cache by a SHA-256 hash of `tenantScope + normalizedQuery + modelProfile + schemaVersion`; never place raw queries in Redis keys.

Refactor graph entity extraction to use the same provider/fallback transport without changing its extraction schema or AGE persistence.

- [ ] **Step 5: Run checks and commit**

Run: `cd backend && bun test src/__tests__/query-expander.test.ts src/__tests__/graph-extract.test.ts src/__tests__/config.test.ts && bun run typecheck`

Expected: PASS.

```bash
git add backend/src/lib/openai-compatible-chat.ts backend/src/search/query-expander.ts backend/src/__tests__/query-expander.test.ts backend/src/lib/graph/extract-entities.ts backend/src/lib/config-schema.ts backend/src/__tests__/config.test.ts .env.example
git commit -m "feat(search): add adaptive multilingual query expansion"
```

### Task 7: Build Automatic GraphRAG Search Orchestration

**Files:**
- Create: `backend/src/search/graph-retriever.ts`
- Create: `backend/src/search/orchestrator.ts`
- Create: `backend/src/__tests__/search-orchestrator.test.ts`
- Modify: `backend/src/lib/graph/search-expansion.ts`
- Modify: `backend/src/__tests__/graph-expand.test.ts`
- Modify: `backend/src/lib/config-schema.ts`

**Interfaces:**
- Consumes Tasks 4-6 and the existing AGE expansion API.
- Produces `searchDocuments(ctx, request): Promise<SearchResponse>`.
- GraphRAG is attempted automatically for every non-empty normal search; it starts from authorized direct document seeds when present and from query-plan concepts/entities when direct seeds are empty. `GRAPH_SEARCH_ENABLED` remains an operator kill switch, not a client mode.

- [ ] **Step 1: Write orchestration tests with fake adapters**

Cover:

1. confident exact plus vector fast pass does not call the LLM;
2. Russian low-confidence fast pass calls the LLM once and reruns only expanded lexical/vector channels;
3. GraphRAG is called without a request flag;
4. graph-only results remain below a strong exact result;
5. provider timeout returns fast-pass results;
6. graph failure returns fused direct results;
7. empty healthy channels return an empty response with diagnostic reason `no_relevant_candidates`;
8. no adapter receives a different tenant context from the route.
9. an empty direct pass still queries AGE by expanded concepts/entities and may return visible graph candidates.

- [ ] **Step 2: Run tests and verify failure**

Run: `cd backend && bun test src/__tests__/search-orchestrator.test.ts src/__tests__/graph-expand.test.ts`

Expected: FAIL because orchestrator and graph adapter are absent.

- [ ] **Step 3: Implement the orchestration sequence**

The exact order is:

```ts
const plan = analyzeQuery(request.query);
const fast = await retrieveFastChannels(ctx, plan, options);
const confidence = evaluateConfidence(fast, plan, thresholds);
const expandedPlan = confidence.confident ? null : await expandQuery(plan, ctx.cacheScope);
const expanded = expandedPlan ? await retrieveExpandedChannels(ctx, expandedPlan.plan, options) : [];
const direct = fuseCandidates([...fast, ...expanded], rankingConfig);
const graph = await retrieveGraphCandidates(ctx, {
  documentSeeds: direct.slice(0, graphSeedLimit),
  queryPlan: expandedPlan?.plan ?? plan,
});
return finalizeSearch([...fast, ...expanded, graph], request, rankingConfig);
```

Use bounded `Promise.allSettled` inside channel groups. Do not repeat the LLM expansion and do not repeat the original query embedding during chunk explanation hydration.

- [ ] **Step 4: Enforce graph visibility and cap**

Pass only authorized document seed IDs into AGE. When document seeds are empty, resolve normalized concepts and named entities to graph nodes without using hidden document metadata. Hydrate every graph neighbor ID through owner/share-scoped PostgreSQL before returning candidates. Set graph evidence to relationship type plus hop count only after visibility validation.

- [ ] **Step 5: Run checks and commit**

Run: `cd backend && bun test src/__tests__/search-orchestrator.test.ts src/__tests__/graph-expand.test.ts src/__tests__/graph-routes.test.ts && bun run typecheck`

Expected: PASS.

```bash
git add backend/src/search/graph-retriever.ts backend/src/search/orchestrator.ts backend/src/__tests__/search-orchestrator.test.ts backend/src/lib/graph/search-expansion.ts backend/src/__tests__/graph-expand.test.ts backend/src/lib/config-schema.ts
git commit -m "feat(search): orchestrate adaptive GraphRAG retrieval"
```

### Task 8: Replace the Search Route and Surface Result Explanations

**Files:**
- Modify: `backend/src/api/routes/search.ts`
- Modify: `backend/tests/integration/routes.search.test.ts`
- Modify: `backend/tests/integration/routes.search-category.test.ts`
- Modify: `frontend/src/lib/api/search.ts`
- Modify: `frontend/src/lib/api/search.test.ts`
- Modify: `frontend/src/lib/components/SearchResult.svelte`
- Create: `frontend/src/lib/components/SearchResult.test.ts`
- Modify: `frontend/src/routes/(app)/search/+page.svelte`

**Interfaces:**
- Consumes `searchDocuments()` from Task 7.
- Public result adds `explanations: SearchExplanation[]` and optional authorized diagnostics; existing document fields remain backward-compatible.
- Removes `graph`, `graphHops`, and `graphBoost` from public query validation after a one-release deprecation response-header window if external compatibility requires it.

- [ ] **Step 1: Write failing API contract tests**

Assert a normal `/api/search?q=english` response invokes the orchestrator with automatic graph enabled and returns:

```json
{
  "explanations": [
    {"channel":"vector","label":"Semantic match"},
    {"channel":"graph","label":"Related concept"}
  ]
}
```

Retain auth, category, folder, tags, date, sort, pagination, and rate-limit tests. Add another-owner and share-guest cases.

- [ ] **Step 2: Make the route a thin adapter**

Keep Zod request parsing, auth/rate-limit, tenant context, and error serialization in `search.ts`. Move retrieval, filters, ranking, chunk hydration, and graph calls to the search domain. Delete the legacy 0.4/0.6 merge and route-local `applyGraphExpansion()`.

- [ ] **Step 3: Update frontend types and component tests**

Add the exact frontend type:

```ts
export interface SearchExplanation {
  channel: "exact" | "fts" | "fuzzy" | "vector" | "expanded_fts" | "expanded_fuzzy" | "expanded_vector" | "graph";
  label: string;
  queryVariant?: string;
}
```

Render at most three explanation badges. Never show raw provider prompts, scores, tenant information, or hidden relationship names. Keep one search box and no GraphRAG toggle.

- [ ] **Step 4: Run backend and frontend tests**

Run: `cd backend && bun test tests/integration/routes.search.test.ts tests/integration/routes.search-category.test.ts`

Run: `cd frontend && bun test src/lib/api/search.test.ts src/lib/components/SearchResult.test.ts`

Expected: PASS.

- [ ] **Step 5: Run browser regression with agent-browser**

Start the app with `bun run dev`, then use the approved `agent-browser` workflow to verify `/search` at desktop and mobile widths, an empty query, a populated query, explanation badges, keyboard navigation, and no browser console errors.

Expected: one search input, stable result layout, no GraphRAG toggle, no failed API requests.

- [ ] **Step 6: Commit**

```bash
git add backend/src/api/routes/search.ts backend/tests/integration/routes.search.test.ts backend/tests/integration/routes.search-category.test.ts frontend/src/lib/api/search.ts frontend/src/lib/api/search.test.ts frontend/src/lib/components/SearchResult.svelte frontend/src/lib/components/SearchResult.test.ts frontend/src/routes/'(app)'/search/+page.svelte
git commit -m "feat(search): expose automatic GraphRAG results"
```

### Task 9: Add Bounded Search Observability and Relevance Evaluation

**Files:**
- Modify: `backend/src/lib/metrics.ts`
- Modify: `backend/src/__tests__/metrics.test.ts`
- Modify: `backend/src/api/routes/metrics.ts`
- Modify: `backend/src/__tests__/metrics-route.test.ts`
- Create: `backend/tests/fixtures/search-relevance.json`
- Create: `backend/src/scripts/benchmark-search.ts`
- Create: `backend/src/__tests__/benchmark-search.test.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Produces per-channel latency/error/candidate metrics, expansion reason/model metrics, empty-result count, graph contribution, and embedding-state inventory.
- Produces `bun run benchmark:search -- --base-url=... --api-key=...` with a non-zero exit when a release gate fails.

- [ ] **Step 1: Write metric registry tests**

Extend the registry with bounded labels represented as fixed metric names, not arbitrary map keys. Required names include `search_fast_duration_ms`, `search_expanded_duration_ms`, `search_expansion_total`, `search_empty_total`, `search_graph_contribution_total`, `search_cross_language_success_total`, `search_expansion_primary_total`, `search_expansion_fallback_total`, and `search_expansion_estimated_cost_microunits`, plus one duration/error/candidate metric per known channel. Rename `embedding_zero` to `embedding_invalid` while preserving the old name as a deprecated read alias for one release.

- [ ] **Step 2: Write evaluation math tests**

Test:

```ts
expect(recallAtK(["doc-b", "doc-a"], ["doc-a"], 10)).toBe(1);
expect(mrrAtK(["doc-b", "doc-a"], ["doc-a"], 10)).toBe(0.5);
expect(percentile([100, 200, 300, 400], 0.95)).toBe(400);
```

- [ ] **Step 3: Add the versioned relevance corpus**

Include judgments for the JSON-decoded queries `\u0430\u043d\u0433\u043b\u0438\u0439\u0441\u043a\u0438\u0439 -> English`, `\u0430\u0432\u0442\u043e\u0440\u0438\u0437\u0430\u0446\u0438\u044f -> authentication`, `\u0440\u0430\u0437\u0432\u0435\u0440\u0442\u044b\u0432\u0430\u043d\u0438\u0435 -> deployment`, and typo `\u0430\u0443\u0442\u0435\u043d\u0442\u0438\u0444\u043a\u0430\u0446\u0438\u044f`, plus thematic no-keyword queries, graph relationship questions, exact titles, code identifiers, irrelevant queries, and two owners with similar private documents. Fixture keys and descriptions remain English; multilingual query values use JSON Unicode escapes in source and decode to the original text at runtime.

- [ ] **Step 4: Implement the benchmark**

The script seeds or references deterministic fixture document IDs, executes the real HTTP search endpoint, records top ten IDs and diagnostics, and prints one JSON summary containing Recall@10, MRR@10, fast p95, expanded p95, expansion rate, graph contribution, empty count, and tenant leakage count.

Exit 1 unless all gates pass:

- Recall@10 >= 0.90;
- MRR@10 >= 0.80;
- fast p95 <= 500 ms;
- expanded p95 <= 2500 ms;
- active invalid vectors = 0;
- tenant leakage = 0;
- every result has at least one explanation.

- [ ] **Step 5: Run tests and commit**

Run: `cd backend && bun test src/__tests__/metrics.test.ts src/__tests__/metrics-route.test.ts src/__tests__/benchmark-search.test.ts && bun run typecheck`

Expected: PASS.

```bash
git add backend/src/lib/metrics.ts backend/src/__tests__/metrics.test.ts backend/src/api/routes/metrics.ts backend/src/__tests__/metrics-route.test.ts backend/tests/fixtures/search-relevance.json backend/src/scripts/benchmark-search.ts backend/src/__tests__/benchmark-search.test.ts backend/package.json
git commit -m "test(search): add relevance and observability gates"
```

### Task 10: Document, Migrate, and Verify the Public Release Contour

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/API.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/PRODUCTION_STATUS.md`
- Modify: `RELEASE_CHECKLIST.md`
- Modify: `.env.example`

**Interfaces:**
- Consumes every previous task.
- Produces a self-contained public setup with OpenRouter defaults, local Ollama alternative, automatic GraphRAG behavior, migration/reindex instructions, rollback, and measurable release gates.

- [ ] **Step 1: Replace stale documentation contracts**

Remove statements that GraphRAG is off by default or requires `?graph=true`. Replace the fixed hybrid-weight formula with channel retrieval plus RRF. Document embedding states, active generations, safe reindex, expansion thresholds, model defaults, and graceful degradation.

- [ ] **Step 2: Document operator commands**

Include exact commands:

```bash
bun run db:migrate
cd backend && bun run src/scripts/reindex-embeddings.ts --dry-run --batch=100
cd backend && bun run src/scripts/reindex-embeddings.ts --batch=100
cd backend && bun run benchmark:search -- --base-url=http://127.0.0.1:50700 --api-key="$HIAI_DOCS_API_KEY"
```

State that the real OpenRouter key belongs only in `.env` or deployment secrets and must not enter Git, package tarballs, Docker layers, logs, screenshots, fixtures, or release notes.

- [ ] **Step 3: Run secret and placeholder scans**

Run:

```bash
rg -n "sk-or-v1-" --glob '!bun.lock' --glob '!.env' --glob '!docs/superpowers/plans/*' .
rg -n "OPENROUTER_API_KEY=" --glob '!bun.lock' --glob '!.env' . | rg -v "change-me-paste-your-openrouter-key-here"
rg -n "TODO|TBD|FIXME" backend/src backend/tests frontend/src packages/db/src docs README.md AGENTS.md RELEASE_CHECKLIST.md
```

Expected: no real key and no unfinished release placeholders in changed files. The public `.env.example` contains only `change-me-paste-your-openrouter-key-here`.

- [ ] **Step 4: Run the complete local verification matrix**

Run from project root:

```bash
bun run test
bun run lint
bun run typecheck
bun run --filter '*' build
docker compose config --quiet
```

Expected: every command exits 0.

- [ ] **Step 5: Verify clean and upgraded database contours**

Using disposable Docker volumes, verify both:

1. fresh PostgreSQL starts, installs vector/vectorscale/AGE/pg_trgm, applies migrations 0000-0025, reindexes fixtures, and passes relevance gates;
2. a pre-0025 database upgrades, keeps old active vectors until replacements are ready, reindexes invalid/stale rows, and passes the same gates.

Expected SQL invariants:

```sql
SELECT count(*) FROM document_embeddings WHERE is_valid = false AND generation_id IN (SELECT active_embedding_generation FROM documents);
-- 0

SELECT count(*) FROM documents WHERE embedding_status = 'ready' AND active_embedding_generation IS NULL;
-- 0
```

- [ ] **Step 6: Build and smoke all images**

Build backend, frontend, and Caddy images with the existing Dockerfiles. Start the reference stack and prefer an in-container health probe when host port mapping is unreliable:

```bash
docker exec hiai-docs-api wget -qO- http://127.0.0.1:50700/api/health
```

Run the relevance benchmark against the live API and use agent-browser for visual search verification at `http://localhost:50701/search`.

- [ ] **Step 7: Commit documentation and release evidence**

```bash
git add README.md AGENTS.md docs/API.md docs/ARCHITECTURE.md docs/DEPLOYMENT.md docs/PRODUCTION_STATUS.md RELEASE_CHECKLIST.md .env.example
git commit -m "docs: publish adaptive GraphRAG search operations"
```

Do not tag, publish, create a GitHub Release, or push until the user explicitly authorizes the release step after reviewing the full verification evidence.

## Execution Dependencies and Parallelization

```text
Task 1 schema --------> Task 3 generation worker ----\
Task 2 validation ----> Task 3 generation worker -----+--> Task 5 retrievers --\
Task 4 pure search primitives ------------------------+-----------------------> Task 7 orchestrator
Task 4 pure search primitives --> Task 6 expansion ---------------------------> Task 7 orchestrator
Task 5 retrievers ------------------------------------------------------------> Task 7 orchestrator
Task 7 orchestrator --> Task 8 route/UI --> Task 9 evaluation --> Task 10 release verification
```

- Tasks 1, 2, and 4 may run in parallel because they own disjoint files.
- Task 6 may start after Task 4 contracts are fixed and can run in parallel with Tasks 2-3 and Task 5.
- Task 3 requires Tasks 1 and 2.
- Task 5 requires Tasks 1, 2, and 4.
- Task 7 requires Tasks 4, 5, and 6; its GraphRAG adapter may be developed in parallel with the orchestrator tests, but integration waits for all three dependencies.
- Task 8 requires Task 7 because it freezes the public response contract.
- Task 9 requires Task 8 so it evaluates the real HTTP and explanation contract.
- Task 10 is intentionally sequential and begins only after all implementation tests pass.

For subagent-driven execution, use at most three workers concurrently:

1. database/indexing worker: Tasks 1 -> 3;
2. search-domain worker: Task 4 -> Task 5 -> Task 7;
3. provider/GraphRAG worker: Task 6, then assists Task 7.

The primary agent owns integration checkpoints, Tasks 8-10, dirty-tree review, secret scans, and final release evidence. No two agents edit `backend/src/lib/config-schema.ts`, `backend/src/search/types.ts`, or `backend/src/search/orchestrator.ts` concurrently.

## Integration Checkpoints

1. **After Tasks 1-4:** schema migration, embedding validation, generation activation, and pure search tests are green; no API behavior changes yet.
2. **After Tasks 5-7:** multilingual retrieval, adaptive expansion, GraphRAG, RRF, tenant isolation, and graceful degradation are green behind the orchestrator boundary.
3. **After Task 8:** the public API and UI use the new orchestrator with explanation-compatible responses.
4. **After Task 9:** objective relevance, latency, invalid-vector, and leakage gates enforce quality.
5. **After Task 10:** fresh install, upgrade, Docker, browser, security, and release checks produce the evidence required for explicit release authorization.
