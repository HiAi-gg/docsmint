# Adaptive Multilingual GraphRAG Search Design

**Status:** Approved design
**Date:** 2026-07-10
**Owner:** hiai-docs

## Goal

Make the default hiai-docs search reliably find relevant content across languages, terminology, spelling variants, and conceptual relationships. A Russian query represented in fixtures as `\u0430\u043d\u0433\u043b\u0438\u0439\u0441\u043a\u0438\u0439` must find documents containing `English`; `\u0430\u0432\u0442\u043e\u0440\u0438\u0437\u0430\u0446\u0438\u044f` must find `authentication`; misspelled and thematic queries must still return useful, explainable results.

The search experience remains a single input. Users do not select retrieval modes or enable GraphRAG manually. The backend chooses the cheapest sufficient path and expands the query only when the first retrieval pass is not confident enough.

## Current-State Problems

The current implementation has several independent gaps:

- PostgreSQL full-text search uses the `english` configuration, so it does not bridge Russian queries to English content.
- Semantic search embeds only the literal query. It has no translation, synonym, or concept expansion when a cross-language embedding is insufficient.
- The frontend does not request the optional GraphRAG path, so graph retrieval is absent from normal searches.
- Text and vector results are merged with a fixed weighted score even though their raw scores are not directly comparable.
- Stored zero vectors are not excluded. They can produce `NaN` cosine similarity and make an embedded document effectively unsearchable.
- Embedding completion does not prove that all chunks contain valid vectors produced by the active model and dimension.

These failures compound. Fixing only query translation or only vector generation would still leave unreliable ranking and silent ingestion failures.

## Product Decisions

1. GraphRAG participates automatically in every normal search. There is no end-user GraphRAG toggle.
2. LLM query expansion is adaptive, not unconditional. A fast retrieval pass runs first; expansion runs only when confidence is low.
3. Retrieval channels are fused with Reciprocal Rank Fusion (RRF), not by mixing incomparable raw scores.
4. Exact and high-confidence semantic matches remain authoritative. Graph expansion cannot displace a strong direct match merely because it traversed more relationships.
5. Invalid vectors are excluded from retrieval and never count as successful ingestion.
6. Search remains useful when the LLM provider, embedding provider, or graph subsystem is unavailable.

## Request and Response Contract

The public search request keeps its existing query, pagination, and filter fields. Graph participation is a backend default rather than a client flag. An internal diagnostics option may expose channel timings and ranking evidence to authorized operators, but it must not expose document data across tenants.

The backend constructs this internal query plan:

```ts
interface QueryPlan {
  original: string;
  normalized: string;
  detectedLanguage: string;
  translations: string[];
  synonyms: string[];
  concepts: string[];
  namedEntities: string[];
}
```

The fast pass uses a minimal plan containing `original`, `normalized`, and locally detected language. The expanded plan is produced at most once per request and is cached by normalized query, tenant scope, model profile, and expansion schema version.

Each returned result includes an explanation suitable for the UI and diagnostics, for example: exact title match, semantic match, translated query match, related graph concept, or agreement across multiple channels. Explanations contain no model chain-of-thought and no inaccessible graph content.

## Search Pipeline

```text
query
  -> normalize and detect language
  -> parallel fast retrieval
       exact/title | multilingual FTS | trigram/fuzzy | vector
  -> confidence gate
       confident -> GraphRAG enrichment -> RRF rank -> results
       uncertain -> LLM QueryPlan -> expanded retrieval
                 -> GraphRAG enrichment -> RRF rank -> results
```

### 1. Normalization

Normalization trims and collapses whitespace, applies Unicode normalization and case folding where appropriate, and preserves the original query for display and exact matching. It must not destructively stem names, identifiers, code symbols, paths, or quoted phrases.

Language detection is lightweight and local. A mixed-language or unknown result is valid and must not block retrieval.

### 2. Fast Retrieval Channels

The backend launches independent, tenant-scoped channels in parallel:

- **Exact/title:** exact phrase, normalized title, slug, and high-value identifier matches.
- **Multilingual FTS:** language-aware lexical retrieval. Documents retain language metadata where known; unknown and mixed content use a compatible simple configuration in addition to language-specific indexes.
- **Trigram/fuzzy:** typo tolerance for titles, headings, terms, and short queries.
- **Vector:** cosine similarity over valid 1024-dimensional chunk embeddings, aggregated to document-level candidates with bounded per-document chunk contribution.

Every channel returns ranked document identifiers and channel-specific evidence. Raw scores remain internal to their own channel.

### 3. Confidence Gate

The fast pass is considered uncertain when any of these conditions holds:

- no exact, lexical, or fuzzy match exists;
- fewer than two independent channels agree on relevant candidates;
- the best valid vector similarity is below the calibrated threshold;
- the query language differs from the likely language of the leading content and no strong cross-language result exists;
- the candidate set is empty.

Thresholds are configuration values calibrated against the acceptance dataset. They are not hard-coded into route handlers.

### 4. Adaptive LLM Expansion

When confidence is low, the query expander produces translations, synonyms, concepts, and named entities as structured JSON matching `QueryPlan`. The default provider profile is:

- primary: `mistralai/ministral-14b-2512`;
- fallback: `google/gemma-4-31b-it`.

Expansion is bounded to one attempt per query. Invalid, empty, oversized, or schema-incompatible output is discarded and search continues with the fast-pass plan. The expander never receives inaccessible document bodies; it receives only the user query and minimal locale context.

Expanded variants run through the lexical, fuzzy, and vector channels. Variant counts and token budgets are capped to prevent latency and cost amplification.

### 5. Automatic GraphRAG

GraphRAG receives the original or expanded concepts and entities plus the leading direct candidates. It adds documents connected through typed graph relationships and supplies traversal evidence.

Graph candidates must satisfy tenant and document visibility predicates at every lookup and traversal step. The graph contribution is bounded, and graph-only candidates receive a lower initial rank prior than direct matches. A graph outage returns an empty graph channel rather than failing the request.

### 6. Rank Fusion

The ranker uses RRF over independent ordered lists:

- exact/title;
- multilingual FTS;
- trigram/fuzzy;
- original-query vector;
- expanded-query lexical and vector lists;
- GraphRAG.

The fusion layer applies explicit, explainable adjustments:

- a strong exact title or identifier match receives a deterministic boost;
- agreement across independent channels receives an agreement boost;
- vector candidates below the minimum similarity are excluded;
- invalid, zero, or non-finite vectors are excluded before ranking;
- graph-only candidates cannot outrank a strong exact or semantic direct match without corroboration;
- repeated chunks from one document cannot dominate the document ranking.

RRF parameters and boosts are versioned configuration and validated by offline relevance tests.

## Embedding and Indexing Lifecycle

Every document embedding generation has an explicit state:

```text
pending -> processing -> ready
                    \-> failed
ready -> stale -> processing
```

`ready` means all searchable chunks have finite, non-zero vectors with the configured dimension, model identifier, and embedding profile version. A partial document is not ready. Zero vectors, wrong dimensions, missing chunks, and provider errors transition the run to `failed` with a safe diagnostic reason.

Changing the embedding model, dimension, chunking profile, or normalization profile marks affected rows `stale`. The production OpenRouter profile uses 1024-dimensional embeddings with:

- primary: `openai/text-embedding-3-small`;
- fallback: `baai/bge-m3`.

Both provider requests must explicitly request or normalize to 1024 dimensions according to their supported API contract. The real OpenRouter key remains local or deployment-secret state; public configuration contains only a placeholder and documented input location.

Reindexing is batched, resumable, idempotent, and observable. Existing valid vectors stay active until a complete replacement set is ready, then the active profile switches atomically. Graph extraction starts only after the corresponding document embedding set is ready. Failed replacements do not destroy the last known-good searchable representation.

Before rollout, all existing vectors are audited. Zero, non-finite, wrong-dimension, unlabelled, and stale rows are quarantined from retrieval and reindexed. The release gate requires zero active invalid vectors.

## Component Boundaries

- **Search route:** validates request, resolves tenant and visibility scope, invokes the orchestrator, and serializes results.
- **Query analyzer:** normalizes input and performs local language detection.
- **Fast retrievers:** independent exact, FTS, fuzzy, and vector adapters with a shared tenant-scoped candidate contract.
- **Confidence evaluator:** makes the deterministic fast-pass or expansion decision and records reason codes.
- **Query expander:** invokes the configured LLM profile and validates structured output.
- **Graph retriever:** resolves concepts, entities, and relationships without bypassing visibility constraints.
- **Fusion ranker:** performs RRF, policy boosts, deduplication, and result explanation generation.
- **Embedding service:** generates and validates vectors and owns embedding profile metadata.
- **Indexing coordinator:** owns document state transitions, resumable reindexing, and graph-extraction sequencing.

These boundaries keep provider selection out of route code and allow each retrieval channel to be tested independently.

## Security and Privacy

- Tenant, workspace, document visibility, and share-link restrictions are applied inside every retrieval query, not only after fusion.
- Query expansion never includes document bodies or candidates from other tenants.
- Cache keys include tenant and visibility scope; shared caches store no cross-tenant result lists.
- Provider keys are accepted only from secret-backed configuration and are never returned by APIs, logs, diagnostics, or public example files.
- Logs contain query hashes or redacted query text according to deployment privacy settings.
- Graph traversals and result explanations cannot reveal hidden node names, relationship metadata, or document existence.

## Failure and Degradation Behavior

- If vector generation fails for a query, lexical, fuzzy, and graph-seeded retrieval continue.
- If LLM expansion fails or times out, the fast-pass result is returned.
- If GraphRAG fails, direct channels still return results.
- If one embedding model fails during indexing, the configured fallback is attempted; the document becomes ready only after validation.
- If PostgreSQL extensions required by a channel are unavailable, startup diagnostics mark that channel unhealthy and search continues through healthy channels where safe.
- Empty search is a valid final outcome only after healthy applicable channels have been attempted. The response exposes a non-sensitive reason code for diagnostics.

## Observability

Metrics and structured diagnostics cover:

- latency, timeout, error, and candidate count per channel;
- fast-pass versus expanded-query latency;
- LLM expansion rate, primary/fallback model usage, validation failures, and estimated cost per query;
- empty-result rate and language-pair success rate;
- graph candidate and final-result contribution;
- channel agreement and confidence-gate reason codes;
- zero, non-finite, wrong-dimension, stale, failed, and pending embedding counts;
- reindex throughput, retries, and remaining documents.

No metric label may contain raw user queries, document text, tenant identifiers with unbounded cardinality, or secrets.

## Verification Strategy

### Unit and Contract Tests

- normalization preserves identifiers, phrases, and Unicode meaning;
- language detection handles Russian, English, mixed, and unknown input;
- confidence-gate reason codes cover every expansion condition;
- LLM output schema rejects malformed or unbounded plans;
- RRF ordering, exact boosts, agreement boosts, and graph caps are deterministic;
- zero, non-finite, stale, and wrong-dimension vectors are excluded;
- tenant filters are mandatory in every retriever and graph traversal;
- fallback behavior returns useful partial results when individual channels fail.

### Integration Tests

- complete ingestion chunks a document, produces valid 1024-dimensional vectors, marks it ready, extracts graph data, and makes it searchable;
- interrupted indexing resumes without duplicates or premature readiness;
- model or dimension changes mark old data stale and atomically replace it;
- OpenRouter primary and fallback profiles honor the dimensional contract;
- normal frontend search automatically uses graph contribution without a graph flag;
- share-link and private-workspace searches return only authorized documents.

### Relevance Dataset

The versioned evaluation corpus includes at least:

- cross-language: `\u0430\u043d\u0433\u043b\u0438\u0439\u0441\u043a\u0438\u0439` -> `English`;
- terminology: `\u0430\u0432\u0442\u043e\u0440\u0438\u0437\u0430\u0446\u0438\u044f` -> `authentication`;
- terminology: `\u0440\u0430\u0437\u0432\u0435\u0440\u0442\u044b\u0432\u0430\u043d\u0438\u0435` -> `deployment`;
- typo: `\u0430\u0443\u0442\u0435\u043d\u0442\u0438\u0444\u043a\u0430\u0446\u0438\u044f` -> authentication-related documents;
- thematic queries that share no exact keywords with the answer;
- entity and relationship questions requiring GraphRAG;
- strong exact-title and code-identifier queries;
- irrelevant queries that should not produce confident false positives;
- tenant-isolation pairs with intentionally similar private content.

### Release Gates

- Recall@10 is at least 0.90 on the approved relevance dataset.
- MRR@10 is at least 0.80.
- Active zero, non-finite, and wrong-dimension vectors equal zero.
- Fast-path search p95 is at most 500 ms in the reference environment.
- Expanded search p95 is at most 2.5 seconds in the reference environment.
- Cross-tenant leakage equals zero across automated isolation tests.
- Every returned result has a non-sensitive explanation and channel evidence.
- The documented Russian-to-English examples return the expected relevant documents.

## Rollout

1. Add embedding validity metadata, lifecycle states, audits, and retrieval-side invalid-vector filtering.
2. Reindex invalid and stale content while retaining last known-good vectors.
3. Introduce the channel contract, language-aware FTS, fuzzy retrieval, and RRF behind an internal search implementation flag.
4. Add the deterministic confidence gate and adaptive LLM expansion with strict budgets and caching.
5. Make GraphRAG an automatic bounded channel and remove the frontend dependency on a graph query flag.
6. Run the relevance, tenant-isolation, failure-injection, and latency suites against a clean database and a migrated database.
7. Enable the new implementation for the reference deployment, observe metrics, then make it the public default.

Rollback switches the search orchestrator to the previous direct retrieval implementation while preserving newly generated valid embeddings and graph data. Schema changes must remain backward-compatible for the duration of the rollout window.

## Out of Scope

- Replacing PostgreSQL, AGE, pgvector, or the existing GraphRAG domain model.
- Moving hiai-docs AI orchestration into Mastra. GraphRAG remains an embedded hiai-docs capability.
- Sending every query to an LLM regardless of fast-pass confidence.
- Requiring OpenRouter when a user has configured compatible local embedding and generation models.
- Exposing provider credentials or a real shared API key in public source, images, packages, or release artifacts.
