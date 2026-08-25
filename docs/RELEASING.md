# Releasing DocsMint

## OSS compatibility policy from 0.7.0

DocsMint OSS 0.7.0 extends the frozen 0.5.0 contract with reusable,
product-neutral category-scoped workspace assertions, effective-category
authorization, index status and refresh contracts, and PWA compatibility. The
0.5.0 snapshot remains the compatibility floor in
`docs/frozen-contract-0.5.0.json`; 0.7.x changes must remain additive.

From 0.7.0:

- reusable self-hosted capabilities belong in OSS when they are exposed through
  supported API, SDK, or frontend contracts;
- Host product workflows consume those public contracts rather than importing
  private OSS source or duplicating editor and store implementations;
- changing or removing an existing export, route, assertion field, role,
  extension slot, or canonical header requires an explicit compatibility
  decision and a new contract baseline;
- billing, product chat, HTML renditions, usage accounting, Stripe, OAuth, and
  host workspace overlays remain outside the OSS distribution.

This is the evergreen maintainer flow for the DocsMint public repository.
Release-specific evidence belongs in CI
and the GitHub Release, not in this file.

## 1. Prepare

1. Work from a clean release branch based on the intended `main` revision.
2. Update `CHANGELOG.md` with user-visible changes and migration notes.
3. Keep the version synchronized in:
   - root `package.json` and `bun.lock` workspace snapshots
   - `package.public.json`
   - `backend/package.json`
   - `frontend/package.json`
   - `packages/db/package.json`
   - `packages/sdk/package.json`
   - `packages/cli/package.json`
   - `packages/mcp-server/package.json`
   - `server.json`
   - backend Swagger metadata
   - `docs/openapi.json`
   - CLI and MCP runtime version strings
   - PWA deployment/cache identity in Vite and Compose
4. Update `.env.example`, documentation, migrations, and OpenAPI whenever their
   public contracts changed.
5. Check that no credentials, local environment files, generated reports, or
   private fixtures are tracked. `AGENTS.md`, `.bob/`, `docs/superpowers/`,
   screenshots, local QA reports, and development fixtures must not enter a
   public release archive unless explicitly classified as public project docs.

## 2. Verify

Run from the repository root:

```bash
bun run test:release
```

The canonical gate rejects any staged, modified, or untracked path before it
runs. Supply its documented test-only service bindings explicitly in the
process environment; it does not read or create a repository environment file.
The gate coordinates the frozen install, version and workflow validators,
production audit, tracked-Git-blob secret scan, lint, typecheck, unit and
contract suites, every workspace build, packed and clean-installed consumers,
Host adoption rehearsal, fresh Docker rebuild, strict port and health checks,
required PostgreSQL and live public integrations, and desktop/mobile
`agent-browser` flows on Lightpanda. Raw logs and machine-readable results are
written under `build/release-evidence/local-release-gate/` and are bound to the
checked-out commit. The Docker lifecycle coordinator writes
`docker-smoke.json`, a sanitized `docker-smoke.log`, and
`docker-smoke.sha256`; it derives the migration result, migrate-container
absence, Compose labels, and service health directly from Git and Docker and
never serializes container environments.

Then verify the release-specific contours affected by the change:

- capture zero skipped tests and expected suite names for required integrations;
- apply the complete migration journal to a fresh database;
- upgrade a representative database when migrations changed;
- build API, web, PostgreSQL, and Caddy images;
- start the stack and check `/api/health` plus the main browser workflows;
- pack the public npm package and test SDK import, CLI help, and MCP startup in
  a clean consumer directory;
- exercise global and category keys when authentication or API routes changed;
- run live search/GraphRAG relevance gates when retrieval or providers changed;
- verify PWA artifact validity and mobile/desktop flows with `agent-browser` on
  Lightpanda. Lightpanda does not implement ServiceWorker or CacheStorage, so
  record that engine limitation explicitly; do not install Chrome as a
  fallback;
- retain the commit-bound browser/Docker results and strict clean-state proof.

Use [Deployment](DEPLOYMENT.md) for database, queue, provider, and operational
details. Do not weaken migrations or disable security features to make a smoke
test pass.

## 3. Publish

Publishing is a separate, explicitly authorized operation.

1. Create one intentional release commit.
2. Repeat the clean-consumer smoke from that commit so `git archive HEAD`
   contains the exact package being released.
3. Confirm the tag version already matches every manifest, `server.json`,
   Swagger/OpenAPI, CLI/MCP runtime, and PWA deployment identity; do not rewrite
   release metadata from the tag.
4. Run `bun run scripts/rehearse-host-0.7-adoption.ts`, then
   `bun run release:check:contract-evidence`. The rehearsal uses only disposable
   host copies and isolated local resources; it must leave the real downstream checkout
   clean. The canonical prepublish gate requires the completed migration evidence
   with the exact closed categories for
   additive/idempotent reapply, no new required environment, atomic package and
   submodule adoption in a disposable host copy, the 0.7 runtime smoke, and the
   0.6.8 rollback-runtime smoke on the same upgraded database. The completion
   also names that exact rehearsal command;
   generic tests and validator self-references are rejected.
5. Create an annotated `v<version>` tag.
6. Push the commit and tag.
7. Wait for GitHub Actions to finish successfully. Every npm, Docker, MCP
   Registry, and GitHub Release publication path transitively depends on the
   complete `release-tag-gate` in `.github/workflows/ci.yml`. That gate requires
   the frozen security/version/evidence checks, lint, typecheck, unit and
   required live integration suites, every build, the clean installed package,
   Docker port/health validation, and executable Lightpanda desktop/mobile
   evidence. Both production Docker jobs upload their commit-bound Docker
   lifecycle JSON, sanitized raw log, and checksum manifest with fail-closed
   missing-file handling. Publication cannot begin while any prerequisite is
   skipped or failed. After npm publication (including the idempotent path when
   the exact version already exists), the workflow resolves the exact registry
   metadata and requires npm `gitHead` to equal the tag commit. It downloads the
   published tarball, verifies both `dist.integrity` and `dist.shasum`, checks the
   committed version, advertised runtime and declaration files, and Bun runtime,
   then runs the clean installed consumer. MCP Registry publication and the
   GitHub Release depend on this commit-bound provenance job and its uploaded
   machine evidence.
8. Create the GitHub Release from the tag using the changelog summary.
9. Confirm the expected npm package and Docker images exist and report the
   released version.
10. Confirm `io.github.HiAi-gg/docsmint` resolves in the official MCP Registry.

The tag workflow publishes `server.json` only after the exact npm artifact has
passed the commit and tarball provenance check. It authenticates
`mcp-publisher` with GitHub Actions OIDC, so the registry can verify the
case-sensitive `io.github.HiAi-gg` namespace without a long-lived secret. The
manual MCP workflow additionally requires the exact 40-character release
commit, checks out that commit, proves that the supplied tag resolves to it, and
runs the same npm provenance verifier before publishing. Keep the
`mcp-publisher` version pinned in `.github/workflows/ci.yml` and validate the
manifest locally before tagging:

```bash
mcp-publisher validate server.json
```

The [LobeHub listing](https://lobehub.com/mcp/hiai-gg-docsmint) is a secondary
catalog entry. The README badge links to the canonical listing. Organization
ownership claims require an interactive maintainer login; complete that step in
LobeHub after the release if its organization claim flow is available. The
repository license is Apache-2.0; catalog UIs that show `Other` must be corrected
from the detected `LICENSE` and package metadata rather than changing the
project license.

Never push, tag, publish npm, publish containers, or create a GitHub Release
without explicit authorization for that release.

## 4. Post-release

- Install from the public artifacts, not the local worktree.
- Smoke login, document creation, import, search, share, images, and export.
- Verify SDK, CLI, and MCP against the released API.
- Verify all three documented MCP installation methods, the hosted
  `https://docsmint.com/mcp` transport, prompts, resources, and the bundled
  document-manager skill.
- Record discovered regressions as new work; do not rewrite historical release
  evidence in this guide.
