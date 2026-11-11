# Changelog

## [1.0.3] — 2026-11-11

- Offer the OAuth consent link in the panel, next to the MCP endpoint, with copy and
  reopen actions: when the browser blocks the popup, the tab is lost, or the flow
  never completes, the link can still be copied and opened by hand.
- Keep the pending consent link in Host state, so it survives a page reload for as
  long as the authorization is valid; withdrawing it on disconnect and replacing it
  when another flow starts.
- Degrade copy to manual selection where the clipboard API is unavailable, and
  report that next to the link instead of in a surface the setup view does not show.

## [1.0.2] — 2026-11-11

- Let the DSH agent discover visible folders and categories with their IDs before placing documents.

## [1.0.1] — 2026-11-11

- Report the DocsMint token refusal reason (`error` / `error_description` from the
  token endpoint) in the panel message, with request credentials redacted, so a
  failure explains itself instead of showing a bare HTTP 400.
- Drop a revoked or expired OAuth record when a refresh is refused with
  `invalid_grant`, and ask for a fresh consent instead of replaying the same 400 on
  every request until the user guesses that reconnecting is the fix.
- Cover both behaviours in the adapter and plugin suites.

## [1.0.0] — 2026-11-04

- Load further document pages while preserving filters and sorting, with unique rows and a shown/total counter.
- Stop pagination when a transport repeats a page; preserve totals and allow retries after errors.
- Show the last successful list refresh time in English and Russian.
- Publish the stable package through the existing OIDC workflow and synchronize a package-root catalog mirror.
- Preserve the rc.2 Host, MCP adapter, authorization and runtime compatibility.

## [1.0.0-rc.2] — 2026-11-04

Repository release candidate. The published rc.1 is a pre-refactoring snapshot
and differs from repository main; rc.2 establishes the repository implementation
as the release source. No rc.1 version is overwritten.

- Include all three test suites, including registered-client coverage.
- Restore updating/removing and troubleshooting documentation.
- Install the packed archive in CI and resolve its public entry points and assets.
- Publish matching release tags to next through OIDC with provenance.
- Registry installation, Cloud OAuth and self-hosted key acceptance must be
  recorded for rc.2 before promotion to 1.0.0.

### Security hardening included in this repository candidate

- Isolate sessions and OAuth state by registering context.
- Serialize credential mutations and reads; prevent refresh, disconnect and concurrent-save races.
- Require the host authorization guard for browser bridge requests.
- Reject redirects, oversized responses and reflected credentials.
- Apply list filters and sorting on the server and preserve workspace-specific document URLs.
- These changes replace the original transfer tarball; rc.2 acceptance remains pending.


All notable changes to `@hiai-gg/dsh-docsmint` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the package follows [Semantic Versioning](https://semver.org/).

## [1.0.0-rc.1] — 2026-11-02

Release candidate, published to the `next` dist-tag. Stable `1.0.0` follows the
same gate once the live acceptance matrix — Cloud OAuth, self-hosted key,
isolation, restart, light/dark panel — passes on the installed registry artifact.
Verified against DSH `0.2.1-rc.5`, DocsMint MCP server `2.0.4` and DocsMint Cloud
OAuth metadata.

### Added

- Left-sidebar entry and a central **DocsMint** panel: connect a workspace, list
  and search documents, read one document, and open it in the DocsMint web app.
- Two deployments: **DocsMint Cloud** (default) and **self-hosted DocsMint OSS**,
  both switchable from the panel and persisted in the credential store.
- Two transports per deployment: **REST API** with an API key, and **MCP**.
  DocsMint Cloud MCP authorizes through the project OAuth flow (OAuth 2.1
  protected-resource and authorization-server discovery, dynamic client
  registration, PKCE S256, refresh). A self-hosted instance uses its API key as a
  Bearer credential against `POST /mcp`.
- Agent tools: `docsmint_search`, `docsmint_get_document`,
  `docsmint_create_document`, `docsmint_update_document` — the same operations the
  panel calls, so both callers behave identically.
- Document filters (workspace, category, folder) and sorting (updated, title,
  created), with an always-available reset.
- Inline creation of categories, folders and documents, and in-place editing of a
  document's title and Markdown body with save.
- Deep links to `/w/<workspace-slug>/documents/<id>`, with the slug resolved from
  the configured workspace or from the MCP workspace listing.
- English and Russian UI, theme-token styling, and display metadata
  (`meta.title`, `meta.description`).
- The real DocsMint brand mark: the sidebar entry draws "dm" plus the leaf from
  the brand asset's own outlines (letters in `currentColor` for both themes, leaf
  in the brand mint `#19B3A8`), and the package icon is the site's own app tile.
- `assets/` with the standalone mark variants (dark ink, light ink, monochrome)
  and a plugin-level test suite for registration, isolation, credential storage
  and unload.

### Notes

- Category filtering narrows the loaded page: the DocsMint document list exposes
  no category parameter, so rows already fetched are filtered locally.
- Self-hosted MCP requires an instance that serves `POST /mcp` over Streamable
  HTTP. DocsMint OSS currently ships MCP as the stdio binary `docsmint-mcp`, so
  API mode is the supported path there until that route lands.
- `engines.dsh` is bounded above (`<0.3.0`) until the suite runs against the next
  Harness minor.
