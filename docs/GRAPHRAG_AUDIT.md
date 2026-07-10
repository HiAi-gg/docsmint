# GraphRAG Infrastructure Audit — hiai-docs

> **⚠️ Historical audit (v0.1.1). All findings resolved by v0.2.1.**
> **Note:** This audit was performed at HEAD `724686c` (v0.1.1). Some items were addressed in the v0.1.1 release. See status annotations below.
> **Audit date:** 2026-07-01, HEAD `724686c` (v0.1.1)
>
> **All G1–G9 and N1 are ✅ Resolved as of v0.2.1 (2026-07-07).** The Post-Audit Resolution table below documents each fix. The "Verdict" and per-item descriptions above are historical — they reflect the broken state found during the audit, not the current codebase.
> **Method:** live DB probes on `:5437` + source code analysis of `backend/src/lib/graph/`, `backend/src/api/routes/{search,graph,admin}.ts`, `backend/src/embedding/`, `packages/db/src/schema.ts`, `postgres/`
> **Nothing was modified** — analysis only.

## Verdict

**GraphRAG is completely non-functional in the current deployment.** The Apache AGE extension is installed but its shared library is never loaded into database sessions, so every `cypher()` call fails. All graph backing tables are empty (0 vertices, 0 edges). Entity extraction, search expansion, graph routes, and admin graph/stats all silently degrade to empty results. Additionally, the default `.env.example` LLM endpoint for entity extraction is misconfigured for Ollama, and the semantic search query bypasses the HNSW vector index.

---

## 🔴 CRITICAL (GraphRAG 100% broken)

### G1. AGE library not loaded — cypher() fails in all sessions

**Root cause:** AGE's `cypher()` function requires the AGE shared library to be loaded into the session (via `LOAD 'age'` or `session_preload_libraries = 'age'`). The library registers parser/planner hooks that intercept cypher calls. Without it, `cypher()` is a dead function that returns `"unhandled cypher(cstring) function call"`.

**Evidence:**
- `SHOW shared_preload_libraries` → empty
- `SHOW session_preload_libraries` → empty
- `postgresql.conf` in the container → no preload settings
- App code: `grep -rn "LOAD.*age" backend/src/ postgres/` → zero matches (only comments)
- `postgres/init.sql` → `CREATE EXTENSION IF NOT EXISTS age` (installs SQL definitions) but no `ALTER DATABASE ... SET session_preload_libraries = 'age'`
- `postgres/Dockerfile` → no `shared_preload_libraries` in CMD or conf

**Proof of breakage:**
```
-- Without LOAD 'age':
SELECT * FROM cypher('docs_graph', $$ MATCH (n) RETURN count(n) $$) AS (count agtype);
→ ERROR: unhandled cypher(cstring) function call  DETAIL: docs_graph

-- With LOAD 'age' first:
LOAD 'age'; SELECT * FROM cypher('docs_graph', $$ MATCH (n) RETURN count(n) $$) AS (count agtype);
→ count: 0  (works, but graph is empty)
```

**Impact:**
- All graph backing tables are EMPTY: Document=0, Person=0, Organization=0, Concept=0, Location=0, Topic=0, MENTIONS=0, REFERENCES=0
- `extractEntities()` → `persistEntities()` → cypher MERGE fails → error caught → returns `[]`
- `expandResults()` → cypher traversal fails → error caught → returns empty Map
- `/api/graph/entities`, `/api/graph/related/:docId`, `/api/graph/search` → all return empty
- `/api/admin/graph/stats` → cypher count fails → returns `{available: false}`
- The graceful degradation (every path wrapped in try/catch) is WHY this went unnoticed

**Fix:** Add to `postgres/init.sql`:
```sql
ALTER DATABASE current_database() SET session_preload_libraries = 'age';
```
Or add to `postgres/Dockerfile` runtime stage a conf snippet. The `ALTER DATABASE ... SET session_preload_libraries` approach is cleaner (no conf file editing, works with any PGDATA).

### G2. Entity extraction LLM endpoint misconfigured for Ollama

`.env.example:58` sets `GRAPH_EXTRACT_BASE_URL=http://localhost:11434/api`. The code in `extract-entities.ts:403` appends `/chat/completions`:
```
http://localhost:11434/api/chat/completions
```
Ollama does NOT have this endpoint:
- Native chat: `POST /api/chat` (different body format)
- OpenAI-compatible: `POST /v1/chat/completions`

The embedding endpoint works because `http://localhost:11434/api` + `/embeddings` = `http://localhost:11434/api/embeddings` (Ollama native). But the chat endpoint is wrong.

With `GRAPH_EXTRACT_ENABLED=true` (`.env.example:56`), every document save triggers a failed LLM call. The error is caught and returns `[]`, so extraction silently no-ops.

**✅ Fixed in v0.1.1** — `.env.example:58` now shows `http://localhost:11434/v1` (correct OpenAI-compatible path).

---

## 🟠 HIGH (performance / latent bugs)

### G3. Semantic search query bypasses the HNSW vector index

`search.ts:476-487` — `semanticSearch` uses:
```sql
SELECT DISTINCT ON (d.id)
    d.id, ..., 1 - (de.embedding <=> $vec::vector) as score, ...
FROM document_embeddings de
JOIN documents d ON d.id = de.document_id
WHERE d.owner_id = $userId AND de.embedding IS NOT NULL
ORDER BY d.id, de.embedding <=> $vec::vector
LIMIT $limit
```

The `ORDER BY d.id, distance` puts `d.id` first, which prevents the planner from using the HNSW index (`idx_document_embeddings_hnsw`). EXPLAIN confirms: full seq scan + sort, NO vector index scan.

At 583 rows / 84 documents: instant. At 100k+ chunks for one tenant: O(N log N) full scan per search query — the HNSW index is wasted.

**Fix:** Use a two-stage query: inner query finds top-k chunks by vector distance (uses HNSW), outer query joins + filters + deduplicates.

### G4. No indexes on AGE vertex `name` columns

`entityUpsertCypher` does `MERGE (e:Person {name: $name})`. Without an index on `name`, every MERGE does a full sequential scan of the label's backing table. Confirmed: zero indexes on `name` in any `docs_graph` label table.

**Fix:** Add GIN indexes on AGE vertex properties in the canonical Drizzle migration `0021_initialize_graphrag.sql`.

### G5. DiskANN index migration never applied

Migration `0008_streaming_diskann_index.sql` exists in the journal (idx 8) and on disk, but the index `idx_document_embeddings_diskann` does NOT exist in the live DB. The `__drizzle_migrations` tracking table does not exist — meaning `drizzle-kit migrate` was never run. The DB was initialized via `db:push` (syncs `schema.ts`), which only defines HNSW, not DiskANN.

README, CHANGELOG, and AGENTS.md all advertise StreamingDiskANN with SbqCompression, but it is not deployed.

**Fix:** Either run `bun run db:migrate` or add the DiskANN index definition to `packages/db/src/schema.ts`.

### G6. `hiai_app` role has wrong search_path order

- `aiuser`: `public, ag_catalog` ✅ (public first, set by `init.sql:65`)
- `hiai_app`: `ag_catalog, public` ❌ (ag_catalog first, NOT set by init.sql)

The `hiai_app` role is created at `init.sql:68-74` but no `ALTER ROLE hiai_app SET search_path` is issued. The init.sql comment explicitly states "public must come first so that Drizzle/Better Auth resolve unqualified table names to `public.documents`".

**Fix:** Add `ALTER ROLE hiai_app SET search_path = public, ag_catalog` to `postgres/init.sql`.

---

## 🟡 MEDIUM

### G7. postgres-js parameterized cypher body may not work with AGE

`search-expansion.ts:64`: `sql\`SELECT * FROM cypher('docs_graph', ${cypher}) AS (...)\`` — `${cypher}` becomes a postgres-js bind parameter. AGE's `cypher()` expects a literal string constant, not a bind parameter. Even after fixing G1, this may fail.

The admin route correctly uses `client.unsafe(literalString)` with `$$ ... $$` dollar-quoting.

**Fix:** Change `search-expansion.ts` to use `client.unsafe()` with the cypher string inlined as a `$$ ... $$` literal.

### G8. `GRAPH_EXTRACT_ENABLED=true` in .env.example

Config schema defaults to `false`, but `.env.example:56-57` sets both graph flags to `true`. For a self-hosted KB where the operator hasn't configured an LLM, this causes every save to trigger a failing LLM call. GraphRAG should be opt-in.

**✅ Fixed in v0.1.1** — `.env.example:56` now shows `GRAPH_EXTRACT_ENABLED=false`.

### G9. Entity persistence runs cypher queries without a transaction

`persistEntities` issues multiple `sql.unsafe()` calls as separate statements with no transaction wrapping. A failure mid-way leaves partial graph state.

**Fix:** Wrap the persistence block in `sql.begin(async (tx) => { ... })`.

---

## 🟢 What works correctly

- **Graceful degradation:** every graph path wrapped in try/catch, returns empty on failure. Graph outages never break search. (Good design, but also why G1 went unnoticed.)
- **Redis + local dedup for entity extraction:** Redis SET NX 24h TTL + local Map 5min TTL. Confidence-based filtering. Well-designed.
- **`search_vector` is a generated column:** auto-updates, GIN index exists, full-text search correct.
- **Chunking + incremental re-embed:** hash-based, O(changed + 2·changed). Correct and efficient.
- **Hybrid search merge:** 0.4 text + 0.6 semantic, graph boost multiplicative. Sound ranking.
- **Graph traversal Cypher:** bounded two-hop traversal through shared entities, compatible with Apache AGE and covered by regression tests.
- **Unified PG image:** pgvector 0.8.3 + pgvectorscale 0.9.0 + AGE 1.7.0 + pg_trgm 1.6 in one PG 18.1. Extensions coexist correctly.

---

## Fix priority order

1. **G1** (blocking) — `ALTER DATABASE ... SET session_preload_libraries = 'age'` in init.sql
2. **G2** (blocking for AI) — fix `.env.example` LLM endpoint for Ollama
3. **G8** — set graph feature flags to `false` in `.env.example`
4. **G7** — switch search-expansion to `client.unsafe()` for cypher
5. **G3** — fix semantic search to use HNSW index
6. **G4** — add `name` indexes on AGE vertex labels
7. **G6** — fix `hiai_app` search_path
8. **G5** — apply diskann migration or add to schema.ts
9. **G9** — wrap entity persistence in a transaction

---

---

## Post-Audit Resolution

| Item | Status | Date | Notes |
|------|--------|------|-------|
| **G1** — AGE `session_preload_libraries` | ✅ Fixed | 2026-07-10 | Covered for fresh installs by `postgres/init.sql` and existing databases by migration `0023_preload_age.sql` |
| **G2** — Ollama endpoint misconfigured | ✅ Fixed | 2026-07-10 | Compose example uses the OpenAI-compatible `http://host.docker.internal:11434/v1` endpoint |
| **G3** — HNSW index bypass in search | ✅ Fixed | 2026-07-01 | Two-stage query rewrites |
| **G4** — No indexes on AGE entity properties | ✅ Fixed | 2026-07-10 | GIN property indexes added in `0021_initialize_graphrag.sql` |
| **G5** — DiskANN index never applied | ✅ Fixed | 2026-07-01 | Added to `packages/db/src/schema.ts` |
| **G6** — `hiai_app` search_path wrong order | ✅ Fixed | 2026-07-01 | `ALTER ROLE hiai_app SET search_path = public, ag_catalog` |
| **G7** — postgres-js parameterized cypher | ✅ Fixed | 2026-07-01 | `search-expansion.ts` now uses `sql.unsafe()` with `$$` dollar-quoting |
| **G8** — Graph flags default `true` in `.env.example` | ✅ Fixed | 2026-07-01 | Both flags set to `false` |
| **G9** — Entity persistence not transactional | ✅ Fixed | 2026-07-01 | `persistEntities` wraps all cypher writes in `sql.begin(async (tx) => { ... })` |

### N1. Graph route (`graph.ts`) cypher bind parameter — found & fixed

- **Found:** 2026-07-07, during post-audit code review of all remaining cypher call sites.
- **Issue:** `fetchDocumentEntities` in `backend/src/api/routes/graph.ts:260-261` used the postgres-js tagged-template form `sql\`SELECT * FROM cypher('docs_graph', ${...})\``, which passes the cypher string as a bind parameter (`$1`). AGE's `cypher()` function inspects its second argument lexically and **rejects** bind parameters — it requires a literal dollar-quoted string constant.
- **Root cause:** The `graph.ts` route was added after the initial `search-expansion.ts` fix (G7) and didn't follow the same pattern. The codebase had three existing safe examples (`search-expansion.ts`, `extract-entities.ts`, `admin.ts`), but the graph route was never refactored to match.
- **Fix:** Replaced the tagged-template with `sql.unsafe()` using `$$ ... $$` dollar-quoting:
  ```typescript
  // Before (broken — bind parameter):
  const rows = await sql<Array<...>>`
      SELECT * FROM cypher('docs_graph', ${cypherDocReplace(cypher, docId)}) AS (...)
  `;

  // After (safe — dollar-quoted literal):
  const queryStr = `SELECT * FROM cypher('docs_graph', $$ ${cypherDocReplace(cypher, docId)} $$) AS (...)`;
  const rows = (await sql.unsafe(queryStr)) as Array<...>;
  ```
- **Escaping preserved:** `cypherDocReplace` still uses `JSON.stringify(docId)` to escape the Zod-validated UUID — same level of injection safety as before.
- **Test coverage:** `backend/src/__tests__/graph-routes.test.ts` (3 tests):
  1. Verifies `sql.unsafe()` is called with `$$` dollar-quoted cypher and no `$1` bind param
  2. Verifies graceful return of `[]` when AGE is unreachable
  3. Verifies special-character docIds are JSON-stringify-escaped correctly
- **Verification:**
  ```bash
  # Run the N1-specific tests
  cd /mnt/ai_data/projects/hiai-docs
  bun test backend/src/__tests__/graph-routes.test.ts --path-ignore-patterns="*node_modules*"
  # → 3 pass, 0 fail

  # Full test suite
  bun test --path-ignore-patterns="*node_modules*"
  # → pre-existing passing suite

  # Typecheck
  bun run typecheck
  ```

### Remaining risks

| Risk | Severity | Notes |
|------|----------|-------|
| **No running AGE session** | 🔴 Critical | G1 fix (ALTER DATABASE SET session_preload_libraries) requires a PG restart or new connection to take effect. Until then, G1 is "fixed in code" but not "deployed." |
| **No production deploy** | 🟡 Medium | All fixes are code-level. No deployment to a running production instance has been performed. |
| **Query plan regression (G3)** | 🟡 Medium | The two-stage query fix for HNSW index usage was not verified with an `EXPLAIN ANALYZE` on a production-sized dataset. |
| **Bun test flakiness** | 🟢 Low | The mock.module approach may be sensitive to test ordering if a sibling test pre-loads the graph/init module before mock.module can intercept it. |
| **Embedding fallback (G2)** | 🟢 Low | If `GRAPH_EXTRACT_BASE_URL` is not set and `EMBEDDING_BASE_URL` is an embedding endpoint (not chat-compatible), the extraction LLM call fails with a confusing error. |

*Audit created 2026-07-01 by audit agent. Resolution entries updated 2026-07-07 (v0.2.1).*
