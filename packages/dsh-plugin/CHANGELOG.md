# Changelog

## Security hardening during OSS import

- Isolate sessions and OAuth state by registering context.
- Serialize credential mutations and reads; prevent refresh, disconnect and concurrent-save races.
- Require the host authorization guard for browser bridge requests.
- Reject redirects, oversized responses and reflected credentials.
- Apply list filters and sorting on the server and preserve workspace-specific document URLs.
- These changes replace the original transfer tarball; registry and live Harness acceptance remain pending.


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
