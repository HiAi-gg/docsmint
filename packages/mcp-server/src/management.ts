import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { HiaiDocsClient } from './client.js';
import { toolOutputSchemas } from './output-schemas.js';

type ToolWrapper = <Args>(name: string, handler: (args: Args) => Promise<unknown>) => (args: Args) => Promise<unknown>;
const uuid = z.string().uuid().describe('UUID of the target object, obtained from the corresponding list tool.');
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const update = { ...write, destructiveHint: true } as const;
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const purge = { ...write, destructiveHint: true } as const;

function unsupported(name: string): never {
  throw new Error(`The injected legacy MCP client does not support ${name}; use a public DocsClient.`);
}

export function registerManagementCapabilities(server: McpServer, client: HiaiDocsClient, wrap: ToolWrapper): void {
  server.registerTool('create_tag', {
    description: 'Create a tag in the active workspace. Requires full workspace write access; category-scoped credentials cannot manage tags. Use add_tag_to_document to assign it.',
    annotations: write,
    inputSchema: z.object({ name: z.string().min(1).max(100).describe('New tag name, up to 100 characters.'), color: z.string().max(20).optional().describe('Optional display color for the new tag, up to 20 characters.') }),
    outputSchema: toolOutputSchemas.create_tag,
  }, wrap('create_tag', async (input: { name: string; color?: string }) => client.createTag ? client.createTag(input) : unsupported('create_tag')) as never);

  server.registerTool('update_tag', {
    description: 'Rename or recolor an existing tag. Requires full workspace write access; category-scoped credentials cannot manage tags. Affected documents are reindexed by the API.',
    annotations: update,
    inputSchema: z.object({ id: uuid, name: z.string().min(1).max(100).optional().describe('Replacement tag name; omit to keep the current name.'), color: z.string().max(20).optional().describe('Replacement display color; omit to keep the current color.') }).refine(value => value.name !== undefined || value.color !== undefined),
    outputSchema: toolOutputSchemas.update_tag,
  }, wrap('update_tag', async ({ id, ...input }: { id: string; name?: string; color?: string }) => client.updateTag ? client.updateTag(id, input) : unsupported('update_tag')) as never);

  server.registerTool('delete_tag', {
    description: 'Delete a tag in the active workspace and remove its document assignments. Requires full workspace write access; category-scoped credentials cannot manage tags.',
    annotations: purge,
    inputSchema: z.object({ id: uuid }),
    outputSchema: toolOutputSchemas.delete_tag,
  }, wrap('delete_tag', async ({ id }: { id: string }) => { if (!client.deleteTag) return unsupported('delete_tag'); await client.deleteTag(id); return { id, deleted: true }; }) as never);

  server.registerTool('add_tag_to_document', {
    description: 'Assign a tag from list_tags to an existing document. Requires edit access to the document and permission to use the tag.',
    annotations: write,
    inputSchema: z.object({ documentId: uuid.describe('UUID of the document to tag.'), tagId: uuid.describe('UUID of the tag returned by list_tags.') }),
    outputSchema: toolOutputSchemas.add_tag_to_document,
  }, wrap('add_tag_to_document', async ({ documentId, tagId }: { documentId: string; tagId: string }) => { if (!client.addTagToDocument) return unsupported('add_tag_to_document'); await client.addTagToDocument(documentId, tagId); return { documentId, tagId, assigned: true }; }) as never);

  server.registerTool('remove_tag_from_document', {
    description: 'Remove a tag assignment from a document. Requires edit access; the tag itself is preserved.',
    annotations: update,
    inputSchema: z.object({ documentId: uuid.describe('UUID of the document whose tag assignment changes.'), tagId: uuid.describe('UUID of the assigned tag to remove.') }),
    outputSchema: toolOutputSchemas.remove_tag_from_document,
  }, wrap('remove_tag_from_document', async ({ documentId, tagId }: { documentId: string; tagId: string }) => { if (!client.removeTagFromDocument) return unsupported('remove_tag_from_document'); await client.removeTagFromDocument(documentId, tagId); return { documentId, tagId, removed: true }; }) as never);

  server.registerTool('update_folder', {
    description: 'Rename or move a folder; changes to category or parent follow API scope rules and trigger reindexing. Requires write access.',
    annotations: update,
    inputSchema: z.object({ id: uuid, name: z.string().min(1).max(255).optional().describe('Replacement folder name; omit to preserve the name.'), parentId: uuid.nullable().optional().describe('New parent folder UUID, or null for a root folder.'), categoryId: uuid.nullable().optional().describe('New category UUID, or null to clear the category.'), order: z.number().int().nonnegative().optional().describe('New non-negative order within the containing folder.') }).refine(value => value.name !== undefined || value.parentId !== undefined || value.categoryId !== undefined || value.order !== undefined),
    outputSchema: toolOutputSchemas.update_folder,
  }, wrap('update_folder', async ({ id, ...input }: { id: string; name?: string; parentId?: string | null; categoryId?: string | null; order?: number }) => client.updateFolder ? client.updateFolder(id, input) : unsupported('update_folder')) as never);

  server.registerTool('update_category', {
    description: 'Rename or reorder a category. Requires full workspace write access; category-scoped credentials cannot modify categories.',
    annotations: update,
    inputSchema: z.object({ id: uuid, name: z.string().min(1).max(255).optional().describe('New category name, up to 255 characters.'), order: z.number().int().nonnegative().optional().describe('New non-negative category order.') }).refine(value => value.name !== undefined || value.order !== undefined),
    outputSchema: toolOutputSchemas.update_category,
  }, wrap('update_category', async ({ id, ...input }: { id: string; name?: string; order?: number }) => client.updateCategory ? client.updateCategory(id, input) : unsupported('update_category')) as never);

  server.registerTool('list_trash', {
    description: 'List soft-deleted documents visible to the active workspace/category. Requires read access.',
    annotations: read,
    inputSchema: z.object({}),
    outputSchema: toolOutputSchemas.list_trash,
  }, wrap('list_trash', async () => client.listTrash ? client.listTrash() : unsupported('list_trash')) as never);

  server.registerTool('restore_trashed_document', {
    description: 'Restore a soft-deleted document from list_trash. Requires write access. This is different from restoring a content version.',
    annotations: write,
    inputSchema: z.object({ id: uuid }),
    outputSchema: toolOutputSchemas.restore_trashed_document,
  }, wrap('restore_trashed_document', async ({ id }: { id: string }) => client.restoreTrashedDocument ? client.restoreTrashedDocument(id) : unsupported('restore_trashed_document')) as never);

  server.registerTool('permanently_delete_document', {
    description: 'Irreversibly purge a document already in trash, including its content and version history. Requires write access. Use only on explicit user request after checking list_trash.',
    annotations: purge,
    inputSchema: z.object({ id: uuid }),
    outputSchema: toolOutputSchemas.permanently_delete_document,
  }, wrap('permanently_delete_document', async ({ id }: { id: string }) => { if (!client.permanentlyDeleteDocument) return unsupported('permanently_delete_document'); await client.permanentlyDeleteDocument(id); return { id, deleted: true }; }) as never);
}
