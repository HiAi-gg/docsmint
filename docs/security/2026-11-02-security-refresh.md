# Security refresh, 2026-11-02

Base: OSS main `50d28a2b44d8f052b34cddc6c154f02029def20f`. Candidate: 2.1.1; not published or deployed by this work.

## Dependency changes

- Bun 1.4.4 in CI, Alpine Docker stages, development examples and runtime metadata. Local checks use an isolated official npm binary with registry SHA-512 verification; DEV-01's default runtime is unchanged.
- SvelteKit 3.1.1, Vite 8.3.5, adapter-node 6.0.1 and vite-plugin-svelte 7.3.1. The project already used SvelteKit 3; no migration is repeated. adapter-static is not used.
- Better Auth and core 1.7.15 remain aligned.
- Compatible same-major resolutions: fast-uri 3.1.9, browserslist 4.29.5, baseline-browser-mapping 2.11.34, serialize-javascript 7.1.4.
- Drizzle and editor packages are unchanged: no relevant advisory was identified in the captured audit. Node-based publication tooling remains Node 24.

## Audit evidence

The complete pre-change audit contains **16 advisory records across six packages**, not 14. The complete post-change audit contains **two moderate records**: glob GHSA-3g3m-2fjr-6pw4 and minimatch GHSA-g3hv-75wg-m249. The production-only audit is empty. Exact JSON responses are committed beside this report.

Both remaining dependencies are build-tool chains: Workbox build uses glob 11, whose available fixed release is 14.0.2 or later; minimatch is consumed by glob 10.x and filelist 5.x ranges, while the advisory's fixed release starts at 11.0.1. Forcing these majors globally would cross upstream compatibility boundaries. No blanket override or audit bypass is added. The production audit gate remains unchanged. A separately reviewed upstream build-tool upgrade is required to close the full development audit.

## Validation

Local checks used Bun **1.4.4** and passed:

- `bun install --frozen-lockfile`.
- `bun run test:unit`, `bun run test:contract`, `bun run lint`, `bun run typecheck`, and `bun run --filter '*' build`.
- Release version validator for `v2.1.1`, MCP catalog validation, and the existing release workflow contract.
- `bun audit --production --json`: `{}` (exit 0). Full audit exits 1 with the two documented moderate build-only advisories; it is not described as clean.

The official `oven/bun:1.4.4-alpine` tag was verified active with linux/amd64 and linux/arm64 images. The Dockerfiles retain their Alpine stages and frozen-install behavior. Actual container rebuild/native dependency execution was **not run locally**; hosted CI must verify it. Required PostgreSQL, browser, clean installed-consumer/package/provenance and live acceptance gates were not run in this task and remain release prerequisites. Existing gates are not bypassed or replaced.

Frozen installation, local source checks, hosted CI, published artifacts and production acceptance remain distinct evidence levels. This task does not publish, tag, merge or deploy.
