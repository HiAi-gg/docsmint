# DocsMint roadmap

DocsMint 0.7.0 is the current public OSS line. This page describes what ships
today, what stays outside the OSS distribution, and the direction of the next
additive work. It is not a dated commitment.

## Now: 0.7.0

A self-hosted, installable knowledge workspace that people and agents share:

- Visual editor and Markdown import/export, with structured TipTap JSON as the
  canonical document model
- Incremental chunking, 1024-dimensional embeddings, and atomic generation
  activation
- Multilingual hybrid search: exact/title, lexical, fuzzy, vector, adaptive
  expansion, GraphRAG, and cross-encoder rerank after reciprocal rank fusion
- REST, TypeScript SDK, CLI, and MCP (17 tools, prompts, resources, and a
  bundled document-manager skill)
- Global and category API keys with explicit `read`, `edit`, and `write`
- Signed category-scoped workspace assertions for trusted server-to-server hosts
- Installable PWA with identity-partitioned offline reading and explicit drafts

The frozen 0.5.0 HTTP and package contract remains the compatibility floor.
0.7.x changes stay additive. See [Releasing](RELEASING.md) for the maintainer
policy and [Changelog](../CHANGELOG.md) for shipped history.

## Out of OSS

These remain host or product concerns and are not part of the Apache-2.0
distribution:

- Host RBAC, billing, invitations, and product UI
- Product chat, HTML renditions, and usage accounting
- Stripe, OAuth, and host workspace overlays

Reusable self-hosted capabilities belong in OSS when they are exposed through
supported API, SDK, or frontend contracts. Host products consume those public
contracts rather than importing private source.

## Next

Work in this line stays additive and operational. The current focus is:

- Keep the public README, API, MCP, and PWA story aligned with the shipped
  0.7.0 contract
- Preserve retrieval quality, authorization, and pipeline recovery under
  concurrent metadata and document work
- Keep REST, SDK, CLI, and MCP as one capability catalog for people and agents

New required environment variables, removed exports, or breaking assertion
fields require an explicit compatibility decision and a new contract baseline.

## How to follow along

- [Changelog](../CHANGELOG.md) — user-visible shipped changes
- [GitHub issues](https://github.com/HiAi-gg/docsmint/issues) — reports and
  proposals
- [Contributing](../CONTRIBUTING.md) — how to send a change
