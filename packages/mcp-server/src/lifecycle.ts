import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { HiaiDocsClient } from './client.js';
import { toolOutputSchemas } from './output-schemas.js';

type ToolWrapper = <Args>(name: string, handler: (args: Args) => Promise<unknown>) => (args: Args) => Promise<unknown>;
function unsupported(name: string): never {
	throw new Error(`The injected legacy MCP client does not support ${name}; use a public DocsClient.`);
}
const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

export function registerLifecycleCapabilities(server: McpServer, client: HiaiDocsClient, wrap: ToolWrapper): void {
  const deletions = [
    {
      name: 'delete_document',
      description:
        'Move an existing document to trash; this is a soft delete and does not permanently purge its content or version history. Requires write access in the active workspace/category. Returns {id, deleted:true}. Use only when the user intends to delete it.',
      action: (id: string) =>
        client.deleteDocument ? client.deleteDocument(id) : unsupported('delete_document'),
      idDescription:
        'UUID of the document to move to trash; obtain it from search_documents, list_documents, or get_document.',
    },
    {
      name: 'delete_folder',
      description:
        'Delete a folder while preserving its documents. Direct child folders and documents are detached according to the server folder rules, and reindexing is queued for affected documents. Requires write access in the active workspace/category. Returns {id, deleted:true}.',
      action: (id: string) =>
        client.deleteFolder ? client.deleteFolder(id) : unsupported('delete_folder'),
      idDescription:
        'UUID of the folder to delete; obtain it from list_folders. This detaches, but does not delete, the documents inside it.',
    },
    {
      name: 'delete_category',
      description:
        'Delete a category and detach its folders and documents without deleting their content. Requires full workspace write access; category-scoped credentials cannot delete any category, including their configured one. Returns {id, deleted:true}.',
      action: (id: string) =>
        client.deleteCategory ? client.deleteCategory(id) : unsupported('delete_category'),
      idDescription:
        'UUID of the category to delete; obtain it from list_categories using a workspace-scoped credential.',
    },
  ] as const;
  for (const tool of deletions) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        annotations,
        inputSchema: z.object({ id: z.string().uuid().describe(tool.idDescription) }),
        outputSchema: toolOutputSchemas[tool.name],
      },
      wrap(tool.name, async ({ id }: { id: string }) => {
        await tool.action(id);
        return { id, deleted: true };
      }) as never
    );
  }
  server.registerTool(
    'restore_document_version',
    {
      description:
        'Restore content for an existing document from a version or named snapshot returned by get_version_history. Requires edit access. The server saves current content in history, records the restoration, and queues indexing. Returns the updated document; it does not recover a trashed document or change folder/category placement.',
      annotations,
      inputSchema: z.object({
        documentId: z
          .string()
          .uuid()
          .describe(
            'UUID of the document whose content should be restored; it must be visible in the active workspace or category.'
          ),
        versionId: z
          .string()
          .uuid()
          .describe(
            'UUID of a version belonging to this document, from get_version_history. Use the version ID, not a snapshot label.'
          ),
      }),
      outputSchema: toolOutputSchemas.restore_document_version,
    },
    wrap(
      'restore_document_version',
      async ({ documentId, versionId }: { documentId: string; versionId: string }) =>
        client.restoreDocumentVersion
          ? client.restoreDocumentVersion(documentId, versionId)
          : unsupported('restore_document_version')
    ) as never
  );
}
