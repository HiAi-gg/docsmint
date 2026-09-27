import { describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { HiaiDocsClient } from './client.js';
import { createDocsmintMcpServer } from './server.js';

const id = 'd1bf444e-15aa-42fe-9f58-687d479a16bd';
const cases = [
  ['search', 'find_documents', { mode: 'search', query: 'research' }],
  ['listDocuments', 'find_documents', { mode: 'list' }],
  ['getDocument', 'read_document', { view: 'detail', id }],
  ['exportDocument', 'read_document', { view: 'markdown', id }],
  ['getVersionHistory', 'read_document', { view: 'versions', id }],
  ['createDocument', 'save_document', { action: 'create', title: 'Example' }],
  ['updateDocument', 'save_document', { action: 'update', id, title: 'Changed' }],
  ['deleteDocument', 'delete_document', { id }],
  ['listFolders', 'list_workspace_structure', { kind: 'folders' }],
  ['listCategories', 'list_workspace_structure', { kind: 'categories' }],
  ['listTags', 'list_workspace_structure', { kind: 'tags' }],
  ['createFolder', 'save_folder', { action: 'create', name: 'Folder' }],
  ['updateFolder', 'save_folder', { action: 'update', id, name: 'Renamed' }],
  ['deleteFolder', 'delete_folder', { id }],
  ['createCategory', 'save_category', { action: 'create', name: 'Category' }],
  ['updateCategory', 'save_category', { action: 'update', id, name: 'Renamed' }],
  ['deleteCategory', 'delete_category', { id }],
  ['createTag', 'save_tag', { action: 'create', name: 'Tag' }],
  ['updateTag', 'save_tag', { action: 'update', id, name: 'Renamed' }],
  ['deleteTag', 'delete_tag', { id }],
  ['addTagToDocument', 'set_document_tag', { action: 'add', documentId: id, tagId: id }],
  ['removeTagFromDocument', 'set_document_tag', { action: 'remove', documentId: id, tagId: id }],
  ['createSnapshot', 'create_snapshot', { documentId: id, label: 'Before edit' }],
  ['restoreDocumentVersion', 'restore_document_version', { documentId: id, versionId: id }],
  ['getRelatedDocuments', 'explore_graph', { mode: 'neighbors', documentId: id }],
  ['searchGraph', 'explore_graph', { mode: 'search', docIds: [id] }],
  ['getDocumentIndexStatus', 'get_document_index_status', { documentId: id }],
  ['refreshDocumentIndex', 'refresh_document_index', { documentId: id }],
  ['listTrash', 'list_trash', {}],
  ['restoreTrashedDocument', 'restore_trashed_document', { id }],
  ['permanentlyDeleteDocument', 'permanently_delete_document', { id }],
] as const;

describe('compact MCP operation routing', () => {
  test('keeps all 31 SDK operations reachable through the 20-tool catalog', async () => {
    const calls: string[] = [];
    const clientImpl = new Proxy({} as HiaiDocsClient, {
      get: (_target, name) => async () => {
        calls.push(String(name));
        throw new Error(`routed:${String(name)}`);
      },
    });
    const server = createDocsmintMcpServer({ client: clientImpl });
    const client = new Client({ name: 'routing-test', version: '1.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(b), client.connect(a)]);
      const tools = new Set((await client.listTools()).tools.map(tool => tool.name));
      expect(tools.size).toBe(20);
      for (const [method, tool, args] of cases) {
        expect(tools.has(tool), tool).toBe(true);
        const result = await client.callTool({ name: tool, arguments: args });
        expect(result.isError, method).toBe(true);
        expect((result.content as Array<{ text: string }>)[0]?.text, method).toContain(`routed:${method}`);
      }
      expect(calls).toEqual(cases.map(([method]) => method));
    } finally {
      await client.close();
      await server.close();
    }
  });
});
