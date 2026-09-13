# Team backlog — docsmint-oss

Source audit: **2026-09-13**. Kind: **library**.
Baseline HEAD: `ecd42746f29b8d5b97fdbf008722f8cbbffb1d1d`; branch: `main`.

Coordination and acceptance: [TEAM_HANDOFF.md](../TEAM_HANDOFF.md).

## Current reconciliation

docs/ROADMAP.md already describes 0.8.3 and is current directionally; old portfolio instruction to rewrite 0.7.0 docs is superseded.

Source checks support this note; they do not certify the running app. Prior live/CI/test claims are historical until rechecked. GitHub freshness was not verified.

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
- Evidence: `canManageWorkspaceTags` + `buildApiAccessValues` behavior tests; HTTP PATCH merge, category-key tag 403, attachment cleanup storageKey; autosave switch/retry 8/8. Backend selected tests 37/37. In-memory harness does not evaluate SQL category predicates on attachment DELETE.
- Delivery: dated acceptance report, reviewable diff if needed, and remaining IDs.

### DOCSMINT-OSS-T02 — Build a repeatable retrieval failure/evaluation matrix

- [ ] **P2** · status: **review** · owner: **grok** · effort: M-L: about 1-2 days
- Depends on: DOCSMINT-OSS-T01.
- Acceptance: Last ready generation remains searchable; rerank identities and authorized graph contributions preserved; dataset, configuration and metrics recorded.
- Evidence: Canonical `evaluateOfflineBaseline()` records graded nDCG@10 0.826458 (DCG gain/log2(rank+1) / ideal DCG) with per-query rows. Matrix tests 5/5. Live rerank not run.
- Delivery: dated acceptance report, reviewable diff if needed, and remaining IDs.

### DOCSMINT-OSS-T03 — Verify REST/SDK/CLI/MCP and packaging compatibility

- [ ] **P2** · status: **review** · owner: **grok** · effort: M-L: about 1-2 days
- Depends on: DOCSMINT-OSS-T01.
- Acceptance: Public 0.5.0 compatibility baseline preserved; package and contract checks cover each surface; no SaaS billing or chat logic added.
- Evidence: Frozen 0.5.0 exports resolve to in-place `packages/sdk/dist` files; DocsClient health/search/createDoc; CLI list+search; MCP dist artifacts. Backend typecheck 0, lint 0. No packed tarball (no copies). Root workspace typecheck blocked by BUN_TMPDIR EACCES.
- Delivery: dated acceptance report, reviewable diff if needed, and remaining IDs.

## Verification entry points

Available script names read from manifests (not executed and not automatically safe):

- `.`: `bun run build`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run test:unit`, `bun run test:contract`, `bun run test:integration`, `bun run test:package`.
- `backend`: `bun run build`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run test:unit`, `bun run test:contract`.
- `frontend`: `bun run build`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run test:unit`.

CI definitions: .github/workflows/ci.yml, .github/workflows/publish-mcp-registry.yml. Presence does not prove a passing run.

Before acceptance attach actual test/typecheck/build evidence and explicitly record pending runtime/visual checks.
