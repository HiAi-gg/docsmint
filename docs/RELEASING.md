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
- SaaS product workflows consume those public contracts rather than importing
  private OSS source or duplicating editor and store implementations;
- changing or removing an existing export, route, assertion field, role,
  extension slot, or canonical header requires an explicit compatibility
  decision and a new contract baseline;
- billing, product chat, HTML renditions, usage accounting, Stripe, OAuth, and
  SaaS workspace overlays remain outside the OSS distribution.

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
bun install --frozen-lockfile
bun run test:unit
bun run test:integration
bun run test:package
bun run lint
bun run typecheck
bun run test
bun run --sequential --filter '*' build
docker compose config --quiet
COMPOSE_BAKE=false docker compose build
```

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
- verify PWA installability, `/sw.js` controller activation, offline fallback,
  absence of private Cache Storage entries, explicit-draft/no-replay behavior,
  and mobile browser flows with `agent-browser`;
- inspect `git diff --check` and run the repository's secret scan.

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
4. Create an annotated `v<version>` tag.
5. Push the commit and tag.
6. Wait for GitHub Actions to finish successfully.
7. Create the GitHub Release from the tag using the changelog summary.
8. Confirm the expected npm package and Docker images exist and report the
   released version.
9. Confirm `io.github.HiAi-gg/docsmint` resolves in the official MCP Registry.

The tag workflow publishes `server.json` only after the exact npm version is
available. It authenticates `mcp-publisher` with GitHub Actions OIDC, so the
registry can verify the case-sensitive `io.github.HiAi-gg` namespace without a long-lived
secret. Keep the `mcp-publisher` version pinned in `.github/workflows/ci.yml` and
validate the manifest locally before tagging:

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
