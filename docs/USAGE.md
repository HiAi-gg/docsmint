# Using hiai-docs

This guide covers the main product workflows. For installation, start with the
[quickstart](../README.md#quick-start). For programmatic access, see the
[API reference](API.md).

## Organize documents

Documents can live at the workspace root or in nested folders. A category is a
separate classification layer: folders describe where content lives, while
categories describe what it belongs to.

- A document or folder can have one category.
- Moving a document or folder does not require changing its category.
- Deleting a category keeps its documents and folders and removes only the
  category assignment.
- Search can be filtered by category, folder, tags, and date.

Use the sidebar menus to create, rename, move, and delete categories and
folders. Duplicate folder names in the same location receive a numeric suffix.
Destructive actions require confirmation.

Category API access is optional. A category key can grant any combination of
`read`, `edit`, and `write` access and cannot access content outside that
category. Global keys cover the owner's complete workspace. Create, copy, and
revoke keys from **Settings → API**. See [API authentication](API.md) for the
permission model.

## Create and edit documents

The visual editor stores both Markdown and structured editor content. It
supports headings, links, tables, lists, task lists, alignment, attachments,
and resizable images. Changes are saved automatically, including formatting,
image insertion, image resizing, and folder or category changes.

Use the editor menu to export Markdown, DOCX, or PDF. Shared pages preserve the
same document content and images. Markdown cannot represent every rich-text
feature, so exports may use portable HTML for elements such as sized images or
complex tables.

## Import documents

Open the dashboard import action and select one or more files. Supported types:

| Type | Behavior |
| --- | --- |
| `.md`, `.markdown`, `.txt` | Imported as text; the filename becomes the title. |
| `.json` | Accepts `title`, `content`, and optional `folderId`. |
| `.docx` | Converted to Markdown while preserving supported document structure. |

Limits are enforced by the API:

- 10 MB per uploaded file
- 10 files and 50 MB total per batch
- 25 MB converted content per file
- 100 MB at the same-origin web proxy boundary

A batch is transactional: if one file cannot be parsed, none of the documents
in that batch are committed. Successfully imported documents are queued for
chunking, embeddings, and GraphRAG extraction automatically. Pipeline state is
visible through the document API; provider failures are retried by the queue and
do not block normal document access.

## Search

Search combines title and exact matches, multilingual lexical search, fuzzy
matching, vector similarity, adaptive query expansion, and GraphRAG. Results
may continue to improve while the semantic stage is running. Recently saved or
imported documents become available to semantic channels after their background
pipeline reaches `ready`; lexical matching remains available before then.

## Share documents

Create a share link from the document menu. Links can have a password,
expiration, and viewer permissions. Revoking a link immediately removes public
access. Images are served through the share-aware attachment route rather than
exposing storage credentials or internal object URLs.

## Keyboard shortcuts

`Mod` means `Command` on macOS and `Ctrl` on Windows and Linux.

| Shortcut | Action |
| --- | --- |
| `Mod+K` | Open Quick Search. |
| `?` | Open keyboard shortcut help. |
| `Esc` | Close the active dialog or overlay. |
| `Mod+B` | Toggle bold in the editor. |
| `Mod+I` | Toggle italic in the editor. |
| `Mod+U` | Toggle underline in the editor. |
| `Mod+Z` / `Mod+Shift+Z` | Undo / redo. |
| `Mod+Shift+7` | Switch between the visual and raw Markdown editors. |
| `Mod+Shift+E` | Export the current document as Markdown. |

The in-product `?` overlay is the source of truth for shortcuts available in
the running version.
