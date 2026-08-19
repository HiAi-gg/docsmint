---
name: docsmint-document-manager
description: Manage and research DocsMint documents through its scoped MCP tools, including categories, folders, hybrid search, GraphRAG, and index refresh.
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

1. Use `search_documents` with the user's original language.
2. Read the most relevant documents with `get_document`.
3. Use `get_related_documents` or `search_knowledge_graph` only with authorized document IDs returned by search.
4. Cite document IDs and distinguish retrieved facts from inference.

## Document management workflow

1. Inspect `list_categories`, `list_folders`, and `list_tags` before organizing content.
2. Create categories only with a workspace-scoped key.
3. Create folders and documents within the active scope.
4. After an update, inspect `get_document_index_status`; use `refresh_document_index` only when indexing is stale or failed.
5. Use snapshots before a substantial rewrite when version history is important.

DocsMint owns chunking, embeddings, multilingual hybrid retrieval, entity extraction, and GraphRAG indexing. Agents must use the MCP tools and never write those persistence layers directly.
