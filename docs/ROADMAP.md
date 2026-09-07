# Roadmap

DocsMint is an open-source knowledge workspace for people, applications, and
AI agents. The 0.8.3 release strengthens existing editing, authorization,
sharing, and SDK behavior without a schema migration. See the
[changelog](../CHANGELOG.md) for shipped changes and the
[project README](../README.md) to try the managed service or self-host.

## Current foundation

- A visual document editor with structured TipTap JSON as canonical content
  and Markdown for source editing, import, and export.
- Folders, categories, tags, sharing, and an installable web application.
- Automatic indexing with incremental embeddings, multilingual hybrid search,
  GraphRAG, and cross-encoder rerank with graceful provider-failure handling.
- REST, TypeScript SDK, CLI, and MCP interfaces for the same knowledge base.
- Global and category-scoped API keys, plus signed workspace assertions for
  host integrations.
- A complete self-hosted Docker stack with PostgreSQL, Redis, and SeaweedFS.

## Near-term priorities

### Make everyday editing dependable

Continue improving autosave, navigation, import, and recovery behavior. Changes
should preserve user content and make pending or failed work understandable.
Regression coverage should exercise document switches, retries, and failures.

### Keep access boundaries consistent

Maintain the same tenant and category permissions across editing, search,
sharing, attachments, and integrations. Fix authorization gaps without
requiring a redesign of existing deployments.

### Keep retrieval accurate and recoverable

Protect document identity through reranking and preserve authorized graph
contributions. Keep the last ready embedding generation searchable during
provider failures, and make optional enrichment failures recoverable without
unnecessary re-embedding. Track retrieval quality with repeatable evaluations.

### Keep public interfaces aligned

Ship capabilities consistently across REST, SDK, CLI, and MCP, or document
why a capability belongs to a specific surface. Keep examples, API reference,
and package exports in sync with released behavior.

### Keep self-hosting practical

Maintain reproducible releases, documented upgrades, and a complete reference
Compose deployment. Improve provider setup and operational guidance while
preserving operator control over secrets, data, and infrastructure.

## Compatibility and scope

The frozen 0.5.0 HTTP and package contract remains the compatibility baseline
for the 0.8.x line. Removing exports or changing assertion fields requires an
explicit compatibility decision. Security fixes may tighten authorization
where previous behavior allowed operations beyond a caller's grant.

The OSS project provides the document workspace and knowledge interfaces.
Host-specific billing, subscriptions, invitations, usage accounting, and
product chat remain responsibilities of the integrating product. The public
extension and workspace-assertion contracts support those integrations without
moving their business logic into the OSS application.

These priorities describe direction, not promised dates. Propose improvements
through the [contribution workflow](../CONTRIBUTING.md), and report security
issues through the [security policy](../SECURITY.md).
