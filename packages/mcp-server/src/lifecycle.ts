import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { HiaiDocsClient } from './client.js';

type ToolWrapper = <Args>(handler: (args: Args) => Promise<unknown>) => (args: Args) => Promise<unknown>;
function unsupported(name: string): never {
  throw new Error(`The injected legacy MCP client does not support ${name}; use a public DocsClient.`);
}
const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

export function registerLifecycleCapabilities(server: McpServer, client: HiaiDocsClient, wrap: ToolWrapper): void {
  const deletions = [
    { name: 'delete_document', description: 'Move a document to trash. Requires write access to the document; category keys are limited to their category. Does not permanently purge content. Returns the document ID and deleted=true. Use only when the user intends deletion.', action: (id: string) => client.deleteDocument ? client.deleteDocument(id) : unsupported('delete_document'), idDescription: 'UUID of the document to move to trash; obtain it from search_documents, list_documents, or get_document.' },
    { name: 'delete_folder', description: 'Delete a folder while preserving its documents. Direct child folders and documents are detached according to the server folder rules, and reindexing is queued for affected documents. Requires write access in the permitted workspace or category. Returns the folder ID and deleted=true.', action: (id: string) => client.deleteFolder ? client.deleteFolder(id) : unsupported('delete_folder'), idDescription: 'UUID of the folder to delete; obtain it from list_folders. This does not delete the documents inside it.' },
    { name: 'delete_category', description: 'Delete a category and detach its folders and documents without deleting their content. Requires full workspace write access; category-scoped keys cannot delete any category, including their own. Returns the category ID and deleted=true.', action: (id: string) => client.deleteCategory ? client.deleteCategory(id) : unsupported('delete_category'), idDescription: 'UUID of the category to delete; obtain it from list_categories using a workspace key.' },
  ];
  for (const tool of deletions) {
    server.registerTool(tool.name, { description: tool.description, annotations, inputSchema: z.object({ id: z.string().uuid().describe(tool.idDescription) }) }, wrap(async ({ id }: { id: string }) => { await tool.action(id); return { id, deleted: true }; }) as never);
  }
  server.registerTool('restore_document_version', {
    description: 'Restore document content from a version or named snapshot returned by get_version_history. Requires edit access to that document. The server backs up the current content, records the restoration, and queues document reindexing. Returns the updated document. Does not restore a document from trash or restore folder/category placement.',
    annotations,
    inputSchema: z.object({
      documentId: z.string().uuid().describe('UUID of the document whose content should be restored; it must be visible in the active workspace or category.'),
      versionId: z.string().uuid().describe('UUID of a version belonging to this document, from get_version_history. Use the version ID, not a snapshot label.'),
    }),
  }, wrap(async ({ documentId, versionId }: { documentId: string; versionId: string }) => client.restoreDocumentVersion ? client.restoreDocumentVersion(documentId, versionId) : unsupported('restore_document_version')) as never);
}
