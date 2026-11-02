# @hiai-gg/dsh-docsmint

DocsMint in the DeepSeek Harness: a **left-sidebar panel** for your workspace and
**four agent tools** the model can call, over either the DocsMint REST API or the
DocsMint MCP server.

- **DocsMint Cloud** (`docsmint.com`) — default. MCP mode authorizes through the
  DocsMint OAuth flow (dynamic client registration + PKCE); API mode uses an API
  key.
- **Self-hosted DocsMint OSS** — second option. API mode works today; MCP mode
  targets an instance that serves `POST /mcp` (Streamable HTTP) and authenticates
  with that instance's API key.

> **Release status: `1.0.0-rc.1`.** The candidate is prepared for the `next`
> dist-tag. Publication uses normal package tests and a release tag. The owner already uses
> the plugin; another live acceptance cycle is not required.

## Install

The bundle is a DSH plugin package (`dsh.bundle.patch` + `dsh.client`). Install it
into a profile from the registry:

```text
plugin_manager install_bundle  target: @hiai-gg/dsh-docsmint
```

Pin the candidate explicitly while it is on `next`:

```bash
dsh plugin --profile docsmint-release-qa add @hiai-gg/dsh-docsmint@1.0.0-rc.1
dsh --profile docsmint-release-qa --dump-config
dsh --profile docsmint-release-qa
```

or from a checkout while developing:

```text
plugin_manager install_bundle  target: <absolute path to this package>
```

Then open the **DocsMint** icon in the left sidebar and connect.

## What the panel does

- Connect DocsMint Cloud through OAuth (no API key), or connect either
  deployment with an API key stored in the Harness credential store.
- Browse documents with **workspace / category / folder filters** and a
  **sort** (updated, title, created), create categories, folders and documents
  inline, and **edit a document's title and Markdown body** and save it.
- Open any document in the DocsMint web app at
  `/w/<workspace-slug>/documents/<id>`.
- Show which tools the agent has and which transport is active.

Category, folder and workspace filters and sorting are sent to the server before
pagination. Use SDK 2.1.0-compatible DocsMint endpoints for this behavior.

## Tools for the agent

| Tool | Purpose |
|---|---|
| `docsmint_search` | Hybrid search over the workspace; returns ids, titles, snippets, scores |
| `docsmint_get_document` | Read one document with its Markdown body and a link |
| `docsmint_create_document` | Create a document, optionally inside a folder |
| `docsmint_update_document` | Update a document's title and/or Markdown body |

The tools use the same operations as the panel, so both stay consistent, and
they follow whatever transport the connection uses.

## Configuration

The Loader row accepts optional fields (all live in `config/cordis.patch.yml`):

| Field | Meaning |
|---|---|
| `baseUrl` | Pins the API base, e.g. `http://localhost:50700/api/v1`. Pinning disables the panel's deployment choice. |
| `mode` | Pins `api` or `mcp` for every session. |
| `deployment` | Pins `cloud` or `self-hosted` semantics. |
| `workspace` | Workspace slug used for `X-Docsmint-Workspace` and for document links. |
| `apiKey` | Key from the patch instead of the credential store (CI and headless setups). |

Credentials live in the Harness credential store under `DOCSMINT_API_KEY`,
`DOCSMINT_WORKSPACE`, `DOCSMINT_ENDPOINT`, `DOCSMINT_MODE` and `DOCSMINT_OAUTH`
(OAuth token record). Environment variables of the same names are honoured as a
fallback.

## Privacy

- The API key and OAuth tokens never reach page code; the panel talks to the
  Host over a same-origin route, and the Host talks to DocsMint.
- The plugin sends nothing anywhere except the DocsMint endpoint you configure
  (`docsmint.com` by default).
- No telemetry, no analytics, no third-party requests.

## Compatibility

Built and tested against DSH `0.2.1-rc.5` (protocol `2025-06-18` for MCP) and
DocsMint MCP server `2.0.4`, on Node 22. `engines` declares both bounds:
`node >=22` and `dsh >=0.2.1-rc.5 <0.3.0` — the upper bound is raised only after
the suite passes against the newer Harness. CI runs Node 22 and 24. The client
half uses only the `slots` and `locale` client services and the `react` module
from the browser module table.

## Brand

The sidebar entry draws the DocsMint mark from the brand asset itself: `dm` plus
the leaf, traced to paths and simplified (mask overlap 0.991 against the trace,
~1.7 KB instead of ~4 KB of pixel steps), so the letters follow `currentColor`
and read on both themes while the leaf keeps the brand mint `#19B3A8`.

`assets/` carries the standalone variants — `docsmint-mark.svg` (dark ink),
`docsmint-mark-dark.svg` (light ink) and `docsmint-mark-mono.svg`
(`currentColor`) — for documentation and for hosts that need a file instead of
inline SVG. The registered plugin icon (`icon.png`) is the DocsMint app tile as
served at `docsmint.com`, so it stays readable in both themes.

## Development

```bash
npm test            # adapter, host security/lifecycle and registered-panel behavior
node test/mcp.mjs   # adapter + OAuth against a local fake MCP server
node test/plugin.mjs # registration, isolation, credentials, unload
node test/client.mjs # registered-panel filter/sort and creation requests
npm pack --dry-run  # what the published tarball contains
```

`ci/dsh-plugin.yml` is the GitHub Actions gate (normal tests on Node 22/24, a package dry run, then OIDC trusted publishing on a
`dsh-plugin-v*` tag). Copy it to `.github/workflows/` in the OSS repository.

## License

Apache-2.0. See [LICENSE](./LICENSE).
