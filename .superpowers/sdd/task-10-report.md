# Task 10 Report: Public Release Documentation and Verification

## Status

Documentation and release-check updates are complete. No tag, publish, Docker
push, npm publish, GitHub release, or Git push was performed.

## Commit

The documentation commit is created after this report is written:

```text
docs: publish adaptive GraphRAG search operations
```

## Documentation delivered

- `README.md` now describes automatic GraphRAG, multilingual retrieval, one-pass adaptive expansion, RRF ranking, safe explanations, and generation-aware embedding lifecycle.
- `AGENTS.md` runtime contracts now match the orchestrator and generation state machine; legacy hybrid weights are explicitly compatibility-only.
- `docs/API.md` documents the current search response, safe explanations, automatic GraphRAG behavior, deprecation-only legacy graph fields, generation-aware admin stats, and safe reindex semantics.
- `docs/ARCHITECTURE.md` documents staged/atomic generations, post-activation extraction, channel retrieval, RRF, graceful degradation, and visibility authorization.
- `docs/DEPLOYMENT.md` includes OpenRouter/Ollama profiles, active `SEARCH_*` configuration, migration/reindex/benchmark commands, release gates, and secret hygiene.
- `docs/PRODUCTION_STATUS.md` records the release-candidate state, objective benchmark gates, and known infrastructure/test blockers.
- `RELEASE_CHECKLIST.md` adds search/lifecycle contract checks, secret scans, benchmark gates, database contours, and agent-browser smoke requirements.
- `.env.example` labels the OpenRouter profile correctly, adds graph result/hop limits, and marks legacy hybrid/graph settings as compatibility values.

## Verification matrix

| Check | Result |
|---|---|
| Secret token scan excluding ignored local `.env` | PASS; no real token found |
| OpenRouter assignment scan excluding placeholder | PASS; only placeholder remains |
| Cyrillic scan across changed public docs/config | PASS; no matches |
| `git diff --check` | PASS |
| `bun run lint` | PASS; backend 110 files, frontend 100 files |
| `bun run typecheck` | PASS; db, backend, frontend |
| `bun run --filter '*' build` | PASS; backend and frontend builds |
| `cd packages/sdk && bun run build` | PASS |
| `docker compose config --quiet` | PASS with explicit non-secret local placeholders; only unset `OWNER_ID`/`HIAI_DOCS_API_KEY` warnings |
| `bun run test` | BLOCKED by seven pre-existing embedding-provider mock failures; backend 569 pass / 7 fail across 576, frontend 55 pass / 0 fail |
| Docker API/web build | INCOMPLETE; escalated build reached final runtime `chown` layers after successful backend/web compilation, then was interrupted before image export |
| Fresh/upgraded database contour | BLOCKED/not rerun in this pass; Task 1 reports the pre-existing migration 0008 DiskANN access-method blocker on the local PostgreSQL image |
| Docker health/in-container smoke | NOT RUN; no completed image export/stack was available after the interrupted build |
| Agent-browser search smoke | NOT RUN; no assembled stack was started |

### Pre-existing test failures

The seven failures are all in embedding-provider/mock expectations, not in the
Task 10 documentation files:

- `embedding-metadata.test.ts`: explicit provider failure expectation
- `embedding.test.ts`: unavailable provider result, primary result profile, primary fallback, invalid-primary fallback, both-invalid failure, and `embedDocument` vector array

They are recorded rather than hidden. The focused search, GraphRAG, route,
visibility, benchmark, and generation suites remain green per Tasks 1–9.

### Known database blocker

Fresh migration verification remains blocked by the existing
`0008_streaming_diskann_index.sql` requirement for a `diskann` access method that
the local PostgreSQL image does not expose. This predates Task 10 and must be
resolved in the image/bootstrap contour before claiming a clean-from-zero
release.

### Credential scope

The benchmark documentation intentionally uses environment/stdin/file-based
credential resolution. API keys are not accepted as command-line arguments and
the real OpenRouter key is never included in this report, docs, fixtures,
Dockerfile, package metadata, or release evidence.
