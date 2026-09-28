import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { HiaiDocsClient } from './client.js';
import { toolOutputSchemas } from './output-schemas.js';
import type { capabilityCatalog } from './capabilities.js';
import { registerBatchAndWorkspaceCapabilities } from './batch-workspace.js';

type ToolName = (typeof capabilityCatalog.tools)[number];
type Wrapper = <Args>(name: string, handler: (args: Args) => Promise<unknown>, outputSchema?: z.ZodType) => (args: Args) => Promise<unknown>;
const uuid = z.string().uuid().describe('UUID returned by the corresponding list or read operation.');
const text = z.string().min(1).describe('Non-empty human-readable name or title.');
const title = z.string().min(1).max(500).describe('Document title, from 1 to 500 characters.');
const content = z.string().describe('Markdown document content; an empty string clears the content on update.');
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const destructive = { ...write, destructiveHint: true } as const;

function required<T>(value: T | undefined, name: string): T {
  if (!value) throw new Error(`The injected legacy MCP client does not support ${name}; use a public DocsClient.`);
  return value;
}

export function registerCompactCapabilities(server: McpServer, client: HiaiDocsClient, wrap: Wrapper): void {
  function register<Schema extends z.ZodType>(name: ToolName, description: string, inputSchema: Schema, annotations: typeof read | typeof write | typeof destructive, handler: (input: z.infer<Schema>) => Promise<unknown>): void {
    server.registerTool(name, { description, inputSchema, outputSchema: toolOutputSchemas[name], annotations }, wrap(name, handler, toolOutputSchemas[name]) as never);
  }

  register('find_documents', 'Find readable documents in the active scope. Use mode=list for paginated browsing by folder or tag UUID; use mode=search for hybrid text and semantic retrieval with tag names.', z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('list').describe('Select the list operation explicitly.'), folderId: uuid.optional(), tag: uuid.optional(), page: z.number().int().min(1).optional().describe('One-based page number; defaults to the API first page.'), limit: z.number().int().min(1).max(1000).optional().describe('Maximum documents per page, up to 1000.') }),
    z.strictObject({ mode: z.literal('search').describe('Select the search operation explicitly.'), query: text.describe('Text to search in the original language.'), folder: z.string().optional().describe('Optional folder UUID filter for search.'), tags: z.array(z.string()).optional().describe('Optional tag names; all supplied names must match.'), limit: z.number().int().min(1).max(100).optional().describe('Maximum results to return, up to 100.') }),
  ]), read, async input => input.mode === 'list'
    ? { operation: 'list', result: await client.listDocuments(input) }
    : { operation: 'search', result: await client.search(input) });

  register('read_document', 'Read one document by UUID. Choose detail for content and metadata, markdown for portable export, or versions for saved revisions and snapshots. All views are read-only.', z.discriminatedUnion('view', [
    z.strictObject({ view: z.literal('detail').describe('Select the detail operation explicitly.'), id: uuid }),
    z.strictObject({ view: z.literal('markdown').describe('Select the markdown operation explicitly.'), id: uuid }),
    z.strictObject({ view: z.literal('versions').describe('Select the versions operation explicitly.'), id: uuid, onlySnapshots: z.boolean().optional().describe('When true, return only named snapshots.') }),
  ]), read, async input => {
    if (input.view === 'detail') return { operation: 'detail', result: await client.getDocument(input.id) };
    if (input.view === 'markdown') return { operation: 'markdown', result: await client.exportDocument(input.id) };
    return { operation: 'versions', result: await client.getVersionHistory(input.id, input.onlySnapshots) };
  });

  register('save_document', 'Create a new document or update an existing document. action=create requires write access; action=update requires edit access for content, and placement changes may require write access. Content or placement changes queue normal indexing.', z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('create').describe('Select the create operation explicitly.'), title: title.optional(), content: content.optional(), folderId: uuid.optional(), categoryId: uuid.nullable().optional().describe('Optional category UUID; null clears the explicit category.') }),
    z.strictObject({ action: z.literal('update').describe('Select the update operation explicitly.'), id: uuid, title: title.optional(), content: content.optional(), folderId: uuid.nullable().optional().describe('Optional folder UUID; null clears the placement on update.'), categoryId: uuid.nullable().optional().describe('Optional category UUID; null clears the explicit category.') }).refine(value => value.title !== undefined || value.content !== undefined || value.folderId !== undefined || value.categoryId !== undefined),
  ]), destructive, async input => {
    if (input.action === 'create') {
      const { action: _action, ...data } = input;
      return { operation: 'create', result: await client.createDocument(data) };
    }
    const { action: _action, id, ...data } = input;
    return { operation: 'update', result: await client.updateDocument(id, data) };
  });

  register('delete_document', 'Move a writable document to trash without purging content or versions. Use only on an explicit delete request; permanently_delete_document is a separate irreversible action.', z.strictObject({ id: uuid }), destructive, async ({ id }) => {
    await required(client.deleteDocument, 'delete_document')(id);
    return { id, deleted: true };
  });

  register('list_workspace_structure', 'List visible folders, categories, or tags in the active workspace or category scope. Set kind=folders to inspect root folders or children of parentId.', z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('folders').describe('Select the folders operation explicitly.'), parentId: uuid.optional() }),
    z.strictObject({ kind: z.literal('categories').describe('Select the categories operation explicitly.') }),
    z.strictObject({ kind: z.literal('tags').describe('Select the tags operation explicitly.') }),
  ]), read, async input => {
    if (input.kind === 'folders') return { operation: 'folders', result: await client.listFolders({ parentId: input.parentId }) };
    if (input.kind === 'categories') return { operation: 'categories', result: await client.listCategories() };
    return { operation: 'tags', result: await client.listTags() };
  });

  register('save_folder', 'Create or update a folder. action=update can rename or move an existing folder; the API enforces category boundaries and queues affected documents for reindexing.', z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('create').describe('Select the create operation explicitly.'), name: text.max(255), parentId: uuid.nullable().optional().describe('Optional parent folder UUID; null selects the root.'), categoryId: uuid.nullable().optional().describe('Optional category UUID; null clears the explicit category.') }),
    z.strictObject({ action: z.literal('update').describe('Select the update operation explicitly.'), id: uuid, name: text.max(255).optional(), parentId: uuid.nullable().optional().describe('Optional parent folder UUID; null selects the root.'), categoryId: uuid.nullable().optional().describe('Optional category UUID; null clears the explicit category.'), order: z.number().int().nonnegative().optional().describe('New non-negative display order.') }).refine(value => value.name !== undefined || value.parentId !== undefined || value.categoryId !== undefined || value.order !== undefined),
  ]), destructive, async input => {
    if (input.action === 'create') {
      const { action: _action, ...data } = input;
      return { operation: 'create', result: await client.createFolder(data) };
    }
    const { action: _action, id, ...data } = input;
    return { operation: 'update', result: await required(client.updateFolder, 'update_folder')(id, data) };
  });

  register('delete_folder', 'Delete a folder while preserving its documents; child folders and documents are detached under the API rules. Requires write access.', z.strictObject({ id: uuid }), destructive, async ({ id }) => {
    await required(client.deleteFolder, 'delete_folder')(id);
    return { id, deleted: true };
  });

  register('save_category', 'Create or update a workspace category. Full workspace write access is required; category-scoped credentials cannot manage categories.', z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('create').describe('Select the create operation explicitly.'), name: text.max(255) }),
    z.strictObject({ action: z.literal('update').describe('Select the update operation explicitly.'), id: uuid, name: text.max(255).optional(), order: z.number().int().nonnegative().optional().describe('New non-negative display order.') }).refine(value => value.name !== undefined || value.order !== undefined),
  ]), destructive, async input => {
    if (input.action === 'create') return { operation: 'create', result: await client.createCategory({ name: input.name }) };
    const { action: _action, id, ...data } = input;
    return { operation: 'update', result: await required(client.updateCategory, 'update_category')(id, data) };
  });

  register('delete_category', 'Delete a workspace category and detach its documents without deleting them. Requires full workspace write access; category-scoped credentials are denied.', z.strictObject({ id: uuid }), destructive, async ({ id }) => {
    await required(client.deleteCategory, 'delete_category')(id);
    return { id, deleted: true };
  });

  register('save_tag', 'Create or update a workspace tag. Full workspace write access is required; renaming or recoloring a tag causes affected documents to be reindexed.', z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('create').describe('Select the create operation explicitly.'), name: text.max(100), color: z.string().max(20).optional().describe('Optional tag color, at most 20 characters.') }),
    z.strictObject({ action: z.literal('update').describe('Select the update operation explicitly.'), id: uuid, name: text.max(100).optional(), color: z.string().max(20).optional().describe('Optional tag color, at most 20 characters.') }).refine(value => value.name !== undefined || value.color !== undefined),
  ]), destructive, async input => {
    if (input.action === 'create') return { operation: 'create', result: await required(client.createTag, 'create_tag')({ name: input.name, color: input.color }) };
    const { action: _action, id, ...data } = input;
    return { operation: 'update', result: await required(client.updateTag, 'update_tag')(id, data) };
  });

  register('delete_tag', 'Delete a workspace tag and remove its document assignments. Full workspace write access is required; documents themselves remain.', z.strictObject({ id: uuid }), destructive, async ({ id }) => {
    await required(client.deleteTag, 'delete_tag')(id);
    return { id, deleted: true };
  });

  register('set_document_tag', 'Add or remove one existing tag assignment on a readable document. Requires edit access to that document; action=remove preserves the tag itself.', z.strictObject({ action: z.enum(['add', 'remove']).describe('Add or remove exactly one tag assignment.'), documentId: uuid, tagId: uuid }), destructive, async ({ action, documentId, tagId }) => {
    if (action === 'add') {
      await required(client.addTagToDocument, 'add_tag_to_document')(documentId, tagId);
      return { operation: 'add', result: { documentId, tagId, assigned: true } };
    }
    await required(client.removeTagFromDocument, 'remove_tag_from_document')(documentId, tagId);
    return { operation: 'remove', result: { documentId, tagId, removed: true } };
  });

  register('create_snapshot', 'Save a named snapshot of an existing document before a planned change. The snapshot can later be restored with restore_document_version.', z.strictObject({ documentId: uuid, label: text.max(200).describe('Snapshot label, from 1 to 200 characters.'), description: z.string().max(1000).optional().describe('Optional snapshot note, at most 1000 characters.') }), write, async ({ documentId, label, description }) => client.createSnapshot(documentId, { label, description }));

  register('restore_document_version', 'Restore content from a version or snapshot listed by read_document(view=versions). This changes current content and queues indexing; it does not restore a trashed document.', z.strictObject({ documentId: uuid, versionId: uuid }), destructive, async ({ documentId, versionId }) => required(client.restoreDocumentVersion, 'restore_document_version')(documentId, versionId));

  register('explore_graph', 'Explore graph relations from readable seed documents. mode=neighbors traverses one document without a query; mode=search ranks relations from one or more seed IDs with optional query text.', z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('neighbors').describe('Select the neighbors operation explicitly.'), documentId: uuid, limit: z.number().int().min(1).max(100).optional().describe('Maximum results to return, up to 100.') }),
    z.strictObject({ mode: z.literal('search').describe('Select the search operation explicitly.'), docIds: z.array(uuid).min(1).max(50).describe('One to 50 authorized seed document UUIDs.'), query: z.string().max(2000).optional().describe('Optional graph relevance query, at most 2000 characters.'), limit: z.number().int().min(1).max(100).optional().describe('Maximum results to return, up to 100.') }),
  ]), read, async input => input.mode === 'neighbors'
    ? { operation: 'neighbors', result: await client.getRelatedDocuments(input.documentId, input.limit) }
    : { operation: 'search', result: await client.searchGraph(input) });

  register('get_document_index_status', 'Read current indexing and pipeline status for one document without starting work. Use refresh_document_index only when an explicit retry is intended.', z.strictObject({ documentId: uuid }), read, async ({ documentId }) => client.getDocumentIndexStatus(documentId));
  register('refresh_document_index', 'Queue an explicit asynchronous reindex for one document. Routine content and placement changes already schedule indexing; check get_document_index_status first.', z.strictObject({ documentId: uuid }), write, async ({ documentId }) => client.refreshDocumentIndex(documentId));
  register('list_trash', 'List soft-deleted documents visible to the active workspace or category scope. Requires read access and does not restore or purge anything.', z.strictObject({}), read, async () => required(client.listTrash, 'list_trash')());
  register('restore_trashed_document', 'Return one soft-deleted document to the active library. This restores the document itself, unlike restore_document_version which changes content.', z.strictObject({ id: uuid }), write, async ({ id }) => required(client.restoreTrashedDocument, 'restore_trashed_document')(id));
  register('permanently_delete_document', 'Irreversibly purge a document already in trash, including its version history. Use only on an explicit user request after checking list_trash.', z.strictObject({ id: uuid }), destructive, async ({ id }) => {
    await required(client.permanentlyDeleteDocument, 'permanently_delete_document')(id);
    return { id, deleted: true };
  });
  registerBatchAndWorkspaceCapabilities(server, client, wrap);
}
