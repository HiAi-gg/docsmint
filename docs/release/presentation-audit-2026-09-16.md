# Publication presentation audit — September 16, 2026

Scope: public metadata and Markdown content, checked against the current checkout.
This is not a container security audit, a runtime certification, or a visual
browser review. No package, image, tag, or remote description was changed.

## Verified publication state

| Surface | Observed state | Presentation finding |
| --- | --- | --- |
| GitHub | Latest release is v0.8.4 | Release body contains one generated PR entry and a comparison link, without a user-facing summary or upgrade instructions. |
| npm | `@hiai-gg/docsmint` latest is 0.8.4 | Description and Cloud onboarding URL are current. One package ships SDK, CLI, and MCP; do not suggest independently published workspace packages. Rendered npm README was not inspected. |
| MCP Registry | Latest active entry is 0.8.4 | Cloud remote and self-hosted npm bridge are present, along with icons and scoped-access guidance. |
| LobeHub | Public skill document reports 0.8.4 | Product overview is current, but generated capability sections expose literal Mustache placeholders and generic stdio instructions use `hiai-gg-docsmint` instead of the published package. |
| Docker Hub | API, Web, and Caddy each have v0.8.4 and role-specific latest tags | Caddy is uploaded last, so its tags lead the recently updated list. All six inspected current tags report Linux amd64. |

Sources checked:

- <https://github.com/HiAi-gg/docsmint/releases/tag/v0.8.4>
- <https://registry.npmjs.org/@hiai-gg%2fdocsmint/latest>
- <https://registry.modelcontextprotocol.io/v0.1/servers/io.github.HiAi-gg%2Fdocsmint/versions/latest>
- <https://lobehub.com/mcp/hiai-gg-docsmint/skill.md>
- <https://hub.docker.com/v2/repositories/vgalibov/docsmint/>
- <https://hub.docker.com/v2/repositories/vgalibov/docsmint/tags?page_size=12>

## Why Caddy appears prominently

`.github/workflows/ci.yml` publishes API, then Web, then Caddy into the shared
`vgalibov/docsmint` repository. Each role gets a versioned and a moving tag.
The current Hub ordering follows those upload times. Caddy is a legitimate
supporting component: `Dockerfile.caddy` builds Caddy 2.11.4 with
`github.com/mholt/caddy-ratelimit@v0.1.0`.

The three application Dockerfiles and their publication steps do not define
DocsMint-specific OCI title, description, source, revision, or version metadata.
Inherited image metadata was not inspected. Do not infer an actual image defect
from the Hub tag order alone.

The Docker Hub README has real line breaks (118), not escaped `\\n` sequences.
It already explains the multi-service stack, but its image section uses generic
tag patterns and omits the supported architecture and absence of a bare `latest`.

## Recommended bounded changes

1. Use the accompanying Docker Hub copy with an explicit service/tag table,
   architecture, and a clear explanation of the proxy. Preserve existing tags.
2. Use the accompanying v0.8.4 release copy, derived from the committed changelog.
   Future releases should load reviewed release notes; the workflow currently
   says "Create release from changelog" but actually uses `--generate-notes`.
   Its existing-release branch updates only the title.
3. Give GitHub a compact product introduction with fewer technology badges near
   the top. Keep Cloud connection and self-hosting as clear separate actions.
   Put runtime/framework badges with contributor information.
4. Keep npm documentation focused on the published package: SDK installation,
   CLI invocation, MCP connection, and runtime requirements. Use absolute GitHub
   links for guides not included in the package. Verify the actual published
   README and tarball before claiming these links are correct on npm.
5. Remove the stale 0.8.3 claim in `docs/README.md`; place `[Unreleased]` before
   versioned entries in `CHANGELOG.md`. Validate SDK examples separately: the
   introductory example currently uses an undeclared `docId` and assumes a
   nonempty document list.
6. Add role-specific OCI metadata to future image builds. Use release tag and
   commit SHA for traceability. Validate publication workflow contracts before
   shipping; do not replace existing versioned images for cosmetic changes.
7. Correct LobeHub's generated installation content through the catalog's
   supported maintenance process. The repository overview already has the
   correct package and endpoint, so a new npm build alone is not a demonstrated
   fix for the catalog template problem.

## Distribution choices

Recommended first step: retain the existing Docker Hub repository and tags,
improve descriptions, and add metadata in the next verified release. This is
the smallest compatible change.

A later alternative is separate Docker Hub repositories for `docsmint-api`,
`docsmint-web`, and `docsmint-caddy`, matching the existing GHCR layout. That
requires an explicit migration and compatibility policy; it is not necessary
to improve today's presentation. Do not point a bare `latest` tag at Caddy or
imply that one image installs the whole product.

ARM64 support would be a separate build-and-test task, not a marketing claim.
The current quickstart builds the complete stack from the repository; published
application images alone do not replace PostgreSQL, Redis, and storage setup.

## Prepared copy and remaining verification

- [Docker Hub description draft](docker-hub-description.md)
- [GitHub v0.8.4 release draft](v0.8.4-notes.md)

These are reviewable local drafts. No source behavior, build pipeline, version,
or remote publication was modified. A subsequent implementation should verify
Markdown links, npm packed content, release-note selection, workflow contracts,
and OCI metadata. Browser appearance and actual MCP connection behavior remain
outside this metadata audit.
