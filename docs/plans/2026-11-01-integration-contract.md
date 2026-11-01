# MCP/REST integration contract: implementation and release readiness

## Approved scope

Keep the existing 22 tool names, discriminators and result envelopes. Preserve
legacy API routes and fields. Add scoped Bearer HTTP MCP to OSS without importing
Cloud OAuth. The shared knowledge implementation remains owned by OSS. Publish
OSS/SDK before Cloud adopts the exact package and submodule commit.

OSS 2.1.0 release metadata is prepared but unpublished. Cloud 1.3.0 remains planned; its published SDK and submodule pins have not yet changed.

## Implemented source

- Protocol-derived, paginated MCP documentation catalog and branch examples.
- Equivalent schema compaction retaining root objects and client routing.
- Compact text serialization of the validated structured result.
- Shared HTTP factory, Origin/CORS, explicit methods and stateless transport.
- Restricted v1 programmatic aliases and bound credential discovery.
- Server-side list and cursor filters, accurate totals and scope-bound cursors.
- Unicode previews, canonical search aliases, explicit/effective categories,
  metadata-rich export, document URLs and optional diagnostics.
- SDK prefix selection, identity methods, list filters and normalized search view.
- Cloud source preparation: discovery, server filters, pagination, authorized URLs,
  shared HTTP transport and generated browser-safe MCP reference.

## Release blockers

**A4: structured JSON-RPC validation diagnostics — IMPLEMENTED AND REVIEWED.**

The installed upstream SDK converts schema ProtocolError to text. The solution
uses its public custom Transport interface and public McpServer subclass hook:
after normal SDK dispatch, only a confirmed argument-validation result is
revalidated against the captured registration schema and emitted as redacted
-32602 data. Valid calls and all other protocol, authentication, scope, disabled
tool and input-limit failures retain upstream handling. No private SDK fields,
dispatch replacement or installed-package edits are used.

Tests cover stdio, the actual public HTTP/server factories, rejection equivalence,
zero storage access for malformed arguments, duplicate IDs, concurrency, close,
cancellation, send failures and capacity overflow. An independent source review
and focused execution found no Critical or Important issues. The exact upstream
validation signature is a compatibility dependency; SDK upgrades must repeat
this matrix. Unexpected shapes pass through unchanged.

**Published adoption — BLOCKED.** Cloud still pins published SDK 2.0.4 and its
matching submodule. Prepared code uses new public exports, so full Cloud build
and deployment require a properly published new package first. The generated
Cloud catalog is explicitly local-development provenance; its production check
must fail until regenerated from the published pinned package. Do not suppress
that check or substitute a local file dependency for release acceptance.

## Compatibility rulings

- Legacy MCP protocol traffic may use SSE despite upstream responseMode=json.
  Preserve standard upstream framing; do not force JSON by dropping events.
- Legacy /api browser/auth Origin and CSRF behavior stays unchanged. The new
  REST Origin gate covers /api/v1; HTTP MCP owns its own Origin check.
- Preserve browser/native workspace-directory responses. Only API credentials
  use the new bound-resource discovery response; invalid keys cannot fall back
  to cookies and Cloud OAuth does not become a REST credential.
- Preserve legacy explicit category fields. Add effective category fields for
  inherited placement and use them for filtering/normalized presentation.
- OSS has no native Cloud workspace slug: do not manufacture one.
- Preserve raw markdown export; format=json adds metadata in one upstream call.

## Verification boundaries

Focused unit, protocol, route and type checks have run locally. Exact command
logs are retained outside tracked source. The new PostgreSQL filtering fixture
is registered in required CI but has not been executed locally. The reported
production empty-preview root cause has not been reproduced; a new preview
field alone is not production evidence.

Full CI, packed consumer verification, live ChatGPT/independent-client acceptance,
publication and Cloud rollout remain separate gates. Use synthetic data and
revoke temporary credentials. No production source, configuration or data has
been changed by this implementation.

**Decision: release candidate only. Publication, pinned Cloud adoption and live acceptance remain separate gates.**
