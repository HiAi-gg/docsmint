# MCP Contract Quality Audit

This report records the static review of the OSS MCP contract at 0.8.9. It is based
on the actual `tools/list` response from the MCP server, source definitions, the
canonical SDK/API inputs, and the package/registry declarations. It contains no
customer data or credentials.

`capabilityCatalog` in `src/capabilities.ts` is the canonical tool, prompt, and
resource inventory. The public `@hiai-gg/docsmint/mcp` entry now exports that same
catalog for consumers that need to compare hosted `tools/list` with the OSS
contract.

## Per-tool audit

| Tool                        | Input contract and bounds                                                                                                                                                       | Permission and side effects                                                                                                                            | Annotations (`readOnly`, `destructive`, `idempotent`, `openWorld`) | Output contract                                | Sibling guidance                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `search_documents`          | Required query string; optional REST `folder` string; tag-name array matches documents with any supplied name; limit 1–100, default 20.                                          | Read access; hybrid retrieval, scoped to active workspace/category.                                                                                    | `true, false, true, false`                                         | SDK `DocsSearchResponse`.                      | Names graph search and graph-neighbor alternatives.                                                          |
| `get_document`              | Required document UUID.                                                                                                                                                         | Read access; no mutation.                                                                                                                              | `true, false, true, false`                                         | SDK `DocsDocument`.                            | Use `export_document` for only the portable Markdown body.                                                   |
| `create_document`           | Optional title 1–500 chars, Markdown content, folder UUID, nullable category UUID. Omitted title uses REST default `Untitled`; folder category contributes effective placement. | Write access in target scope; category credentials remain bound to their category; normal create queues indexing asynchronously.                       | `false, false, false, false`                                       | SDK `DocsDocument`.                            | Use only for new content; use `update_document` for an existing document.                                    |
| `update_document`           | Required document UUID; optional title 1–500 chars, content, nullable folder/category placement. Omitted fields remain unchanged.                                               | Edit for title/content; write for placement. Saves prior content to version history and queues indexing for relevant changes.                          | `false, true, false, false`                                        | SDK `DocsDocument`.                            | Read first; use `create_document` for new content.                                                           |
| `list_documents`            | Optional folder UUID and tag UUID; page ≥1, default 1; limit 1–1,000, default 20.                                                                                               | Read access; no mutation.                                                                                                                              | `true, false, true, false`                                         | SDK `DocsDocumentListResponse`.                | Use `search_documents` for text or semantic retrieval.                                                       |
| `list_folders`              | Optional parent folder UUID; omit to list roots.                                                                                                                                | Read access in active workspace/category; no mutation.                                                                                                 | `true, false, true, false`                                         | SDK `DocsFolder[]`.                            | Use `create_folder` to add a folder.                                                                         |
| `create_folder`             | Name 1–255 chars; optional nullable parent and category UUIDs.                                                                                                                  | Write access; nested folders inherit parent category; category credentials cannot create outside scope.                                                | `false, false, false, false`                                       | SDK `DocsFolder`.                              | Use `list_folders` to inspect placement.                                                                     |
| `create_snapshot`           | Document UUID; label 1–200 chars; optional description ≤1,000 chars.                                                                                                            | Edit access; records a named current-content snapshot without changing content.                                                                        | `false, false, false, false`                                       | SDK `DocsVersion`.                             | Use returned version ID with `restore_document_version`.                                                     |
| `get_version_history`       | Document UUID; optional `onlySnapshots` boolean.                                                                                                                                | Read access; no mutation.                                                                                                                              | `true, false, true, false`                                         | SDK `DocsVersion[]`.                           | Use `restore_document_version` only when the user asks to restore content.                                   |
| `export_document`           | Required document UUID.                                                                                                                                                         | Read access; no mutation.                                                                                                                              | `true, false, true, false`                                         | Stable `{ markdown, filename? }` result.       | Use `get_document` for editable content and complete metadata.                                               |
| `list_categories`           | No parameters.                                                                                                                                                                  | Read access; category-scoped credentials see only their configured category.                                                                           | `true, false, true, false`                                         | SDK `DocsCategoryListItem[]`; permission fields are omitted for API-key principals when the REST API omits them. | Use before selecting an existing category.                                                                   |
| `create_category`           | Name 1–255 chars; unsupported `description` input removed because the REST schema strips it.                                                                                    | Workspace-level write access; category-scoped credentials cannot create categories.                                                                    | `false, false, false, false`                                       | SDK `DocsCategory`.                            | Use `list_categories` to inspect existing categories.                                                        |
| `list_tags`                 | No parameters.                                                                                                                                                                  | Read access in active workspace/category; no mutation.                                                                                                 | `true, false, true, false`                                         | SDK `DocsTag[]`.                               | IDs filter `list_documents`; names filter `search_documents`.                                                |
| `get_related_documents`     | Required non-empty document ID; optional limit 1–100.                                                                                                                           | Read access; graph traversal stays within active scope.                                                                                                | `true, false, true, false`                                         | SDK `DocsGraphRelatedResponse`.                | For a text query use `search_knowledge_graph`; this tool needs no query.                                     |
| `search_knowledge_graph`    | 1–50 non-empty seed document IDs; optional query ≤2,000 chars; optional limit 1–100.                                                                                            | Read access; graph search stays within active scope.                                                                                                   | `true, false, true, false`                                         | SDK `DocsGraphSearchResponse`.                 | Obtain readable seed IDs with `search_documents`; use related-documents for neighbors without query ranking. |
| `get_document_index_status` | Required document UUID.                                                                                                                                                         | Read access; reads current index/pipeline state only.                                                                                                  | `true, false, true, false`                                         | SDK `DocsDocumentIndexStatus`.                 | Check before deciding whether to call `refresh_document_index`.                                              |
| `refresh_document_index`    | Required document UUID.                                                                                                                                                         | Write access; explicitly queues an asynchronous reindex.                                                                                               | `false, false, false, false`                                       | SDK `DocsDocumentIndexRefresh`.                | Normal content changes already schedule indexing; use for an intentional retry.                              |
| `delete_document`           | Required document UUID.                                                                                                                                                         | Write access; moves document to trash and retains its content/history.                                                                                 | `false, true, false, false`                                        | Stable `{ id, deleted: true }` acknowledgment. | Destructive soft-delete; call only on user intent.                                                           |
| `delete_folder`             | Required folder UUID.                                                                                                                                                           | Write access; deletes folder, detaches children/documents per server rules, and queues affected-document indexing.                                     | `false, true, false, false`                                        | Stable `{ id, deleted: true }` acknowledgment. | Documents are preserved; inspect folder contents first.                                                      |
| `delete_category`           | Required category UUID.                                                                                                                                                         | Full workspace write access; category-scoped credentials cannot delete categories; detaches content without deleting it.                               | `false, true, false, false`                                        | Stable `{ id, deleted: true }` acknowledgment. | Requires a workspace-scoped credential.                                                                      |
| `restore_document_version`  | Document UUID and version UUID.                                                                                                                                                 | Edit access; saves current content in history, restores selected content, and queues indexing. Does not restore trashed documents or change placement. | `false, true, false, false`                                        | SDK `DocsDocument`.                            | Select version IDs from `get_version_history`; do not confuse with snapshot labels.                          |

The annotation values reflect effects of the actual handlers. All tools are closed
world (`openWorldHint: false`): they operate on DocsMint data and do not browse or
modify external systems. Update/restore/delete are marked destructive because they
can replace or remove user-visible state; create, snapshot, and refresh are mutable
but do not overwrite existing document content.

## Deterministic lint and scoring

- TDQS CLI: `mcp-tdqs` 0.2.0.
- Input: a temporary export of all 21 tools returned by the local server's
  `tools/list`; the export was removed after linting.
- Static lint command: `npx -y mcp-tdqs@0.2.0 lint --file <temporary-tools.json> --fail-on warning`.
- Result: 21 tools, TDQS specification 1.3; 100% parameter-description coverage,
  annotations present, and output schema present for every tool; 0 errors, 0
  warnings, 0 notes. The CLI emitted static cost values 0–2 per tool; these are not
  quality scores or tiers.
- Numeric score/tier and model-scored dimensions are unavailable for all 21 tools.
  No authorized calibrated model configuration was available, so this report makes
  no numeric score or B-tier distribution claim. The deterministic lint emitted no
  parameter schema gaps, annotation contradictions, or other smell findings.

## Registry, package, and transport checks

- Runtime names, canonical catalog names, README tool names, and LobeHub tool names
  are compared directly, including uniqueness; registry prompt/resource/tool counts
  are derived from the canonical catalog.
- The public package declaration exposes `capabilityCatalog`; the packed-package
  smoke test compares its tool names with the actual packaged MCP `tools/list`.
- The LobeHub Market CLI `@lobehub/market-cli` 0.0.41 generated a temporary manifest
  from the real local stdio endpoint and discovered 21 tools, 2 prompts, and 3
  resources. Its generated tool entries, including `outputSchema`, matched the
  committed LobeHub `tools` array exactly. No marketplace publish action was
  performed.
- The deterministic stdio test lists the same 21 tools and verifies every tool
  carries its output schema.
- OSS source/package checks do not prove that production `https://docsmint.com/mcp`
  has updated. Hosted parity and production provenance remain for the SaaS release
  and deployment checks; unauthenticated production discovery is not tool-list
  evidence.

## Confirmed REST scope defect

A controlled HTTP integration regression demonstrated that a credential limited to
`category:A:write` could create a document with `categoryId=A` inside a folder whose
effective category was B. The route returned 201 before the fix. The REST create
boundary now resolves every supplied folder's effective category and rejects a
category-scoped credential whose folder is outside its configured category, even
when `categoryId` is explicitly supplied. The regression now returns 403 with no
document created; a same-category placement remains allowed. This is a verified
authorization defect fix, separate from the MCP definition-quality improvements.
