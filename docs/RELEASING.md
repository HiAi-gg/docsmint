# Releasing hiai-docs

This is the evergreen maintainer flow. Release-specific evidence belongs in CI
and the GitHub Release, not in this file.

## 1. Prepare

1. Work from a clean release branch based on the intended `main` revision.
2. Update `CHANGELOG.md` with user-visible changes and migration notes.
3. Keep the version synchronized in:
   - `package.json`
   - `package.public.json`
   - `backend/package.json`
   - `frontend/package.json`
   - `packages/db/package.json`
   - `packages/sdk/package.json`
   - `packages/cli/package.json`
   - `packages/mcp-server/package.json`
   - backend Swagger metadata
   - `docs/openapi.json`
4. Update `.env.example`, documentation, migrations, and OpenAPI whenever their
   public contracts changed.
5. Check that no credentials, local environment files, generated reports, or
   private fixtures are tracked.

## 2. Verify

Run from the repository root:

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run --filter '*' build
docker compose config --quiet
```

Then verify the release-specific contours affected by the change:

- apply the complete migration journal to a fresh database;
- upgrade a representative database when migrations changed;
- build API, web, PostgreSQL, and Caddy images;
- start the stack and check `/api/health` plus the main browser workflows;
- pack the public npm package and test SDK import, CLI help, and MCP startup in
  a clean consumer directory;
- exercise global and category keys when authentication or API routes changed;
- run live search/GraphRAG relevance gates when retrieval or providers changed;
- inspect `git diff --check` and run the repository's secret scan.

Use [Deployment](DEPLOYMENT.md) for database, queue, provider, and operational
details. Do not weaken migrations or disable security features to make a smoke
test pass.

## 3. Publish

Publishing is a separate, explicitly authorized operation.

1. Create one intentional release commit.
2. Repeat the clean-consumer smoke from that commit so `git archive HEAD`
   contains the exact package being released.
3. Create an annotated `v<version>` tag.
4. Push the commit and tag.
5. Wait for GitHub Actions to finish successfully.
6. Create the GitHub Release from the tag using the changelog summary.
7. Confirm the expected npm package and Docker images exist and report the
   released version.

Never push, tag, publish npm, publish containers, or create a GitHub Release
without explicit authorization for that release.

## 4. Post-release

- Install from the public artifacts, not the local worktree.
- Smoke login, document creation, import, search, share, images, and export.
- Verify SDK, CLI, and MCP against the released API.
- Record discovered regressions as new work; do not rewrite historical release
  evidence in this guide.
