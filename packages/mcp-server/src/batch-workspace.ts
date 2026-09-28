import type { McpServer } from '@modelcontextprotocol/server';
import { isDocsApiError } from '@hiai-docs/sdk';
import { z } from 'zod';
import { HiaiDocsError, type HiaiDocsClient } from './client.js';
import { toolOutputSchemas } from './output-schemas.js';

type Wrapper = <Args>(name: string, handler: (args: Args) => Promise<unknown>, outputSchema?: z.ZodType) => (args: Args) => Promise<unknown>;

const uuid = z.string().uuid().describe('UUID of an item visible to the active API key.');
const documentIds = z.array(uuid).min(1).max(25)
  .refine(ids => new Set(ids).size === ids.length, 'Document IDs must be unique.')
  .describe('One to 25 distinct document UUIDs, explicitly selected by the user; no search expansion.');
const base = { documentIds };
const batchInput = z.discriminatedUnion('action', [
  z.strictObject({ ...base, action: z.literal('move').describe('Move each document to the same folder.'), folderId: uuid.nullable().describe('Destination folder UUID, or null for no folder.') }),
  z.strictObject({ ...base, action: z.literal('set_category').describe('Set one explicit category on every document.'), categoryId: uuid.nullable().describe('Category UUID, or null to clear explicit category.') }),
  z.strictObject({ ...base, action: z.literal('add_tag').describe('Assign one existing tag to every document.'), tagId: uuid.describe('Existing tag UUID to assign to each document.') }),
  z.strictObject({ ...base, action: z.literal('remove_tag').describe('Remove one tag assignment from every document.'), tagId: uuid.describe('Existing tag UUID to unassign from each document.') }),
  z.strictObject({ ...base, action: z.literal('trash').describe('Move every document to trash without permanent deletion.') }),
  z.strictObject({ ...base, action: z.literal('restore').describe('Restore every selected document from trash.') }),
  z.strictObject({ ...base, action: z.literal('refresh_index').describe('Request explicit indexing retry for every document.') }),
]);

function required<Args extends unknown[], Result>(method: ((...args: Args) => Promise<Result>) | undefined, name: string): (...args: Args) => Promise<Result> {
  if (!method) throw new Error(`The injected legacy MCP client does not support ${name}; use a public DocsClient.`);
  return method;
}

export function registerBatchAndWorkspaceCapabilities(server: McpServer, client: HiaiDocsClient, wrap: Wrapper): void {
  async function batch(input: z.infer<typeof batchInput>) {
    const results: Array<{ id: string; status: 'ok' | 'error' | 'skipped'; error?: { status: number; code: string; message: string } }> = [];
    let aborted = false;
    for (const id of input.documentIds) {
      if (aborted) {
        results.push({ id, status: 'skipped' });
        continue;
      }
      try {
        switch (input.action) {
          case 'move':
            await client.updateDocument(id, { folderId: input.folderId });
            break;
          case 'set_category':
            await client.updateDocument(id, { categoryId: input.categoryId });
            break;
          case 'add_tag':
            await required(client.addTagToDocument, 'add_tag')(id, input.tagId);
            break;
          case 'remove_tag':
            await required(client.removeTagFromDocument, 'remove_tag')(id, input.tagId);
            break;
          case 'trash':
            await required(client.deleteDocument, 'trash')(id);
            break;
          case 'restore':
            await required(client.restoreTrashedDocument, 'restore')(id);
            break;
          case 'refresh_index':
            await client.refreshDocumentIndex(id);
            break;
        }
        results.push({ id, status: 'ok' });
      } catch (error) {
        const known = isDocsApiError(error) || error instanceof HiaiDocsError;
        const status = known ? error.status : 500;
        const code = known ? error.code : 'INTERNAL_ERROR';
        results.push({ id, status: 'error', error: { status, code, message: known ? error.message : 'Document operation failed' } });
        if (status === 401 || status === 429) aborted = true;
      }
    }
    const succeeded = results.filter(result => result.status === 'ok').length;
    return { action: input.action, total: input.documentIds.length, succeeded, failed: results.filter(result => result.status === 'error').length, aborted, results };
  }

  server.registerTool('batch_documents', {
    description: 'Apply one action to 1–25 explicitly selected document IDs. Supports move, set_category, add_tag, remove_tag, trash, restore, or refresh_index. Processes sequentially through the existing API so each document keeps its own workspace and category permission check. Returns per-ID success or error; partial success is possible. Stops after authentication or rate-limit failure. Permanent purge and version restore are intentionally separate tools.',
    inputSchema: batchInput,
    outputSchema: toolOutputSchemas.batch_documents,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, wrap('batch_documents', batch, toolOutputSchemas.batch_documents) as never);

  server.registerTool('get_workspace_item', {
    description: 'Read one visible folder, category, or tag by UUID. Folder uses its direct API getter; category and tag lookup uses the complete permission-filtered lists. An absent or out-of-scope ID is reported as not found. Use list_workspace_structure to discover IDs first.',
    inputSchema: z.strictObject({ kind: z.enum(['folder', 'category', 'tag']).describe('The workspace resource type to read by ID.'), id: uuid }),
    outputSchema: toolOutputSchemas.get_workspace_item,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, wrap('get_workspace_item', async ({ kind, id }: { kind: 'folder' | 'category' | 'tag'; id: string }) => {
    if (kind === 'folder') return { operation: kind, result: await required(client.getFolder, 'get_workspace_item(folder)')(id) };
    const listed = kind === 'category' ? await client.listCategories() : await client.listTags();
    const result = Array.isArray(listed) ? listed.find((item: { id?: unknown }) => item.id === id) : undefined;
    if (!result) throw new HiaiDocsError(`${kind} not found`, 404, null, 'NOT_FOUND');
    return { operation: kind, result };
  }, toolOutputSchemas.get_workspace_item) as never);
}
