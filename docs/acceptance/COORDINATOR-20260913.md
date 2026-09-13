# Independent source acceptance — 2026-09-13

Scope accepted for draft review: extracted category PATCH permission merge and tag-management policy, behavioral access/cleanup regressions, canonical offline retrieval evaluation, autosave/CLI/public-surface fixtures.

Local independent checks passed: focused access/evaluation tests; three HTTP route cases with mocked DB/storage (12 assertions); backend TypeScript; repository lint; backend production build (1884 modules). Earlier independent review verified canonical nDCG10 0.826458 and its numerator/ideal-denominator calculation. No real database or provider was used.

This is source acceptance, not a release. PostgreSQL predicate/locking/restart behavior, isolated packed SDK/CLI/MCP consumer compatibility, full frontend integration and browser/runtime acceptance remain pending. In-place dist checks are not packed-install proof. Exact draft-PR CI will determine clean-runner integration status; failures must remain visible.

The existing docs/ROADMAP.md working change is excluded and preserved byte-for-byte from the audit baseline. The hosted docsmint repository's docsmint-oss submodule pin remains ecd42746f29b8d5b97fdbf008722f8cbbffb1d1d. No schema/version bump, main merge, tag, registry publication or deployment is included.


## CI ordering correction independently accepted
The first draft-head unit job exposed a new dependency on generated SDK frontend artifacts before build. Grok prepared a partial correction but both runs ended cancelled; coordinator independently completed verification rather than accepting a cancelled run.
Source manifest assertions remain in backend units; the mocked DocsClient test now imports source in the SDK unit suite. All export/MCP artifact assertions moved to scripts/assert-public-export-artifacts.ts, explicitly invoked after SDK/workspace builds in CI and package verification. Workflow validation enforces ordering; no checks are skipped.
Independent clean-order proof: ignored packages/sdk/dist was reversibly renamed in-place, with no tracked files inside; source/client tests passed (2 tests, 157 assertions), artifact gate failed on missing dist/index.js, and original output was restored. Canonical build:sdk then rebuilt output from scratch and artifact gate passed. Workflow/script contract tests, typecheck:scripts and lint also passed.
This follow-up corrects CI placement only. No hosted submodule pin or old roadmap changes. Exact follow-up CI remains required.
