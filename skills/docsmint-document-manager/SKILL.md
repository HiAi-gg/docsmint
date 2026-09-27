---
name: docsmint-document-manager
description: Manage and research DocsMint documents through its scoped MCP tools, including categories, folders, hybrid search, GraphRAG, rerank, and index refresh.
---

# DocsMint Document Manager

Use this skill when an agent must create, organize, edit, or research documents in a DocsMint workspace.

## Safety and access

- Treat the configured API key as the complete authority boundary.
- A workspace key may manage categories, folders, tags, and documents according to its role.
- A category key may access only its bound category, folders and documents inside that category, and explicitly granted `read`, `edit`, or `write` operations.
- Never attempt to manage API keys, members, billing, or workspace settings through document tools.
- Read a document before changing it. Preserve its language and structure unless the user asks otherwise.

## Retrieval workflow

1. Use `find_documents(mode=search)` with the user's original language; use `mode=list` for paginated browsing by folder or tag UUID.
2. Read relevant content with `read_document(view=detail)` or export Markdown with `view=markdown`.
3. Use `explore_graph(mode=neighbors|search)` only with authorized document IDs returned by `find_documents`.
4. Cite document IDs and distinguish retrieved facts from inference.

## Document management workflow

1. Inspect `list_workspace_structure(kind=categories|folders|tags)` before organizing content.
2. Create or update categories with `save_category(action=create|update)` only with a workspace-scoped key.
3. Use `save_folder`, `save_document`, `save_tag`, and `set_document_tag` with explicit actions and stay in the active scope.
4. After a document update, inspect `get_document_index_status`; use `refresh_document_index` only when indexing is stale or failed.
5. Use `create_snapshot` before a substantial rewrite; choose a version through `read_document(view=versions)` before `restore_document_version`.
6. Treat `delete_document`, `restore_trashed_document`, and `permanently_delete_document` as distinct lifecycle actions. Purge only on an explicit request.

DocsMint owns chunking, embeddings, multilingual hybrid retrieval, cross-encoder rerank, entity extraction, and GraphRAG indexing. Agents must use the MCP tools and never write those persistence layers directly.
