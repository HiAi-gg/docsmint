# Task 4 Report: Pure Search Primitives

Status: complete

## Scope

Implemented only the provider-independent search domain primitives requested by Task 4:

- Unicode-safe query normalization and local script-based language detection;
- `QueryPlan`, candidate, channel, confidence, ranking, and explanation contracts;
- deterministic expansion confidence evaluation;
- reciprocal rank fusion with exact-title and channel-agreement boosts;
- graph-only contribution capping, duplicate document/chunk collapse, vector thresholding, and stable ID tie-breaking.

## Commit

Implementation commit: `4a92db0 feat(search): add query confidence and RRF primitives`

## Files

- `backend/src/search/types.ts`
- `backend/src/search/query-analyzer.ts`
- `backend/src/search/confidence.ts`
- `backend/src/search/rrf.ts`
- `backend/src/__tests__/search-query-analyzer.test.ts`
- `backend/src/__tests__/search-confidence.test.ts`
- `backend/src/__tests__/search-rrf.test.ts`

## Verification

Focused tests:

```text
bun test src/__tests__/search-query-analyzer.test.ts src/__tests__/search-confidence.test.ts src/__tests__/search-rrf.test.ts
14 pass
0 fail
25 expect() calls
```

Focused TypeScript compilation for the new modules and tests:

```text
tsc --noEmit --ignoreConfig ...
pass
```

Focused Biome check:

```text
Checked 7 files in 4ms. No fixes applied.
```

The repository-wide backend `bun run typecheck` is currently blocked by unrelated concurrent edits in `backend/src/__tests__/config.test.ts` (parse errors at lines 149, 168, 169, and 170). Those files are outside Task 4 and were not modified by this task.

## Concerns

- `evaluateConfidence` accepts both flattened candidates and future `ChannelResult[]` values so the later orchestrator can consume the same pure contract.
- Language mismatch remains an explicit threshold signal because retrieval adapters, not the local script detector, own corpus-language evidence.
- No database, Redis, configuration, HTTP, embedding, or provider imports were added.

## Reviewer Fix Verification (2026-07-11)

The reviewer findings were limited to the Task 4 primitives:

- Minimum vector similarity and finite-score validation now apply to both `vector` and `expanded_vector` candidates.
- Query normalization collapses whitespace only outside quoted phrases and preserves phrase-internal whitespace.
- Cyrillic test fixtures use Unicode escapes so the test source remains ASCII-only.

Bun 1.3.14 treats multiple test paths passed to one `bun test` invocation as a single filter. The three focused files were therefore run independently with the following exact results:

```text
$ bun test ./src/__tests__/search-query-analyzer.test.ts
5 pass
0 fail
9 expect() calls
Ran 5 tests across 1 file.

$ bun test ./src/__tests__/search-confidence.test.ts
5 pass
0 fail
7 expect() calls
Ran 5 tests across 1 file.

$ bun test ./src/__tests__/search-rrf.test.ts
5 pass
0 fail
10 expect() calls
Ran 5 tests across 1 file.
```

Focused TypeScript compilation:

```text
$ bunx tsc --noEmit --ignoreConfig --target ESNext --module ESNext --moduleResolution bundler --strict --noUncheckedIndexedAccess --skipLibCheck --types @types/bun src/search/types.ts src/search/query-analyzer.ts src/search/confidence.ts src/search/rrf.ts src/__tests__/search-query-analyzer.test.ts src/__tests__/search-confidence.test.ts src/__tests__/search-rrf.test.ts
exit code 0 (no output)
```

Focused Biome check:

```text
$ backend/node_modules/.bin/biome check backend/src/search/types.ts backend/src/search/query-analyzer.ts backend/src/search/confidence.ts backend/src/search/rrf.ts backend/src/__tests__/search-query-analyzer.test.ts backend/src/__tests__/search-confidence.test.ts backend/src/__tests__/search-rrf.test.ts
Checked 7 files in 5ms. No fixes applied.
```
