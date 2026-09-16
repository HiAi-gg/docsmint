# Team backlog — docsmint-oss

Source audit: **2026-09-13**. Night continuation: **2026-09-14**. Next-night: **2026-09-15**. Kind: **library**.
Baseline HEAD: `2e85740fff16a781c6c330e243d2fa8a1fd632d7` (`origin/main`, tag `v0.8.4`).
Working branch: `review/next-night-20260915`.

Coordination and acceptance: [TEAM_HANDOFF.md](../TEAM_HANDOFF.md).
2026-09-15 packet: [docs/acceptance/NEXT-NIGHT-20260915.md](docs/acceptance/NEXT-NIGHT-20260915.md).

## Current reconciliation

docs/ROADMAP.md already describes 0.8.3 and is current directionally; old portfolio instruction to rewrite 0.7.0 docs is superseded.

Source checks support this note; they do not certify the running app. Prior live/CI/test claims are historical until rechecked. GitHub freshness was not verified this pass.

2026-09-14 (NIGHT_GROK_PLAN): local tenant SQL, mixed-key fail-closed, unsigned workspace header, category-write attachment DELETE 403, tests/typecheck/build. Root typecheck 0 with writable `TMPDIR`. Owner-dirty `docs/ROADMAP.md` 2026-09-13 banner preserved. **DNS `docsmint.com` frozen. DOCSMINT-01 production not edited.** Hosted pin remains `ecd42746f29b8d5b97fdbf008722f8cbbffb1d1d`.

Recent local commits:

- `ecd4274 release: v0.8.3 reliable saves, scoped access, and clearer product docs`
- `1527c3c fix(ci): pin Tiptap and xmldom, stop Bun/Node type collisions`
- `17a7472 chore: pin Drizzle 0.45.2 and frontend Svelte 5.57`

## Read first

- [docs/ROADMAP.md](docs/ROADMAP.md)
- [docs/RELEASING.md](docs/RELEASING.md)
- [docs/API.md](docs/API.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [CHANGELOG.md](CHANGELOG.md)

## Dependencies and scope

No cross-project implementation dependency assigned in this pass.
Use isolated fixtures. No production change, DNS, publishing, real messages or financial action is implied.

## Task ledger

Effort is a planning estimate, not a deadline. Confirm the first task baseline before implementation; already implemented work becomes verification.

### DOCSMINT-OSS-T01 — Turn 0.8.3 editing/access priorities into regression coverage

- [ ] **P1** · status: **review** · owner: **grok** · effort: M: about 0.5-1 day
- Depends on: current baseline and cited source inspection.
- Acceptance: Document switches, retries, category-scoped keys and attachments retain correct identity and authorization across failures.
- Evidence: `canManageWorkspaceTags` + `buildApiAccessValues` behavior tests; HTTP PATCH merge, category-key tag 403, attachment cleanup storageKey; autosave switch/retry 8/8. 2026-09-14: personal vs external tenant SQL, mixed category-key fail-closed, unsigned workspace header 401, category-write attachment DELETE 403 (row retained). Auth/tenant suite 47/47 (194 expect). In-memory harness does not evaluate SQL category predicates on attachment DELETE.
- Delivery: dated acceptance report, reviewable diff if needed, and remaining IDs.

### DOCSMINT-OSS-T02 — Build a repeatable retrieval failure/evaluation matrix

- [ ] **P2** · status: **review** · owner: **grok** · effort: M-L: about 1-2 days
- Depends on: DOCSMINT-OSS-T01.
- Acceptance: Last ready generation remains searchable; rerank identities and authorized graph contributions preserved; dataset, configuration and metrics recorded.
- Evidence: Canonical `evaluateOfflineBaseline()` records graded nDCG@10 0.826458 (DCG gain/log2(rank+1) / ideal DCG) with per-query rows. Matrix tests 5/5. 2026-09-15 live rerank `--mode=rerank --live`: nDCG@10 1.000, MRR 1.000, Recall@10 1.000, 12 queries. 2026-09-16 follow-up: login/register 502 mapping proved on local `127.0.0.1:50701` preview (network error, not credential copy).
- Delivery: dated acceptance report, reviewable diff if needed, and remaining IDs.

### DOCSMINT-OSS-T03 — Verify REST/SDK/CLI/MCP and packaging compatibility

- [ ] **P2** · status: **review** · owner: **grok** · effort: M-L: about 1-2 days
- Depends on: DOCSMINT-OSS-T01.
- Acceptance: Public 0.5.0 compatibility baseline preserved; package and contract checks cover each surface; no SaaS billing or chat logic added.
- Evidence: Frozen 0.5.0 exports resolve to in-place `packages/sdk/dist` files; DocsClient health/search/createDoc; CLI list+search; MCP dist artifacts. 2026-09-14: backend/frontend typecheck 0, lint 0, backend build 1884 modules, frontend vite build 0, `test:package:artifacts` 0. Root workspace typecheck 0 with `TMPDIR=/tmp/docsmint-oss-bun` (default bunx tmp may still EACCES). No packed tarball (no copies).
- Delivery: dated acceptance report, reviewable diff if needed, and remaining IDs.

## Verification entry points

Available script names read from manifests (not executed and not automatically safe):

- `.`: `bun run build`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run test:unit`, `bun run test:contract`, `bun run test:integration`, `bun run test:package`.
- `backend`: `bun run build`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run test:unit`, `bun run test:contract`.
- `frontend`: `bun run build`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run test:unit`.

CI definitions: .github/workflows/ci.yml, .github/workflows/publish-mcp-registry.yml. Presence does not prove a passing run.

Before acceptance attach actual test/typecheck/build evidence and explicitly record pending runtime/visual checks.
