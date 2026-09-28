import { describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { HiaiDocsClient } from './client.js';
import { HiaiDocsError } from './client.js';
import { createDocsmintMcpServer } from './server.js';

const first = 'd1bf444e-15aa-42fe-9f58-687d479a16bd';
const second = 'e8cb77e1-7c4b-4e76-99b9-34fe6b2f9582';
const tagId = '7c41c371-ddf0-43df-b621-df066da12c3c';

async function connected(clientImpl: HiaiDocsClient) {
  const server = createDocsmintMcpServer({ client: clientImpl });
  const client = new Client({ name: 'batch-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

function structured(result: { structuredContent?: unknown }) {
  return result.structuredContent as Record<string, unknown>;
}

describe('bounded MCP batch and workspace inspection', () => {
  test('reports each result and continues after a per-document scope denial', async () => {
    const calls: string[] = [];
    const session = await connected({
      addTagToDocument: async (id: string, tag: string) => {
        calls.push(`${id}:${tag}`);
        if (id === first) throw new HiaiDocsError('Forbidden', 403, null);
      },
    } as unknown as HiaiDocsClient);
    try {
      const result = await session.client.callTool({ name: 'batch_documents', arguments: {
        action: 'add_tag', documentIds: [first, second], tagId,
      } });
      expect(result.isError).not.toBe(true);
      expect(structured(result)).toMatchObject({
        action: 'add_tag', total: 2, succeeded: 1, failed: 1, aborted: false,
        results: [
          { id: first, status: 'error', error: { status: 403 } },
          { id: second, status: 'ok' },
        ],
      });
      expect(calls).toEqual([`${first}:${tagId}`, `${second}:${tagId}`]);
    } finally { await session.close(); }
  });

  test('stops after authentication or rate-limit failure without retrying other IDs', async () => {
    const calls: string[] = [];
    const session = await connected({
      deleteDocument: async (id: string) => {
        calls.push(id);
        throw new HiaiDocsError('Unauthorized', 401, null);
      },
    } as unknown as HiaiDocsClient);
    try {
      const result = await session.client.callTool({ name: 'batch_documents', arguments: {
        action: 'trash', documentIds: [first, second],
      } });
      expect(structured(result)).toMatchObject({
        total: 2, succeeded: 0, failed: 1, aborted: true,
        results: [{ id: first, status: 'error' }, { id: second, status: 'skipped' }],
      });
      expect(calls).toEqual([first]);
    } finally { await session.close(); }
  });

  test('routes every supported batch action through its existing scoped client method', async () => {
    const calls: unknown[][] = [];
    const session = await connected({
      updateDocument: async (id: string, input: unknown) => { calls.push(['update', id, input]); return {}; },
      removeTagFromDocument: async (id: string, tag: string) => { calls.push(['remove_tag', id, tag]); },
      deleteDocument: async (id: string) => { calls.push(['trash', id]); },
      restoreTrashedDocument: async (id: string) => { calls.push(['restore', id]); return {}; },
      refreshDocumentIndex: async (id: string) => { calls.push(['refresh_index', id]); return {}; },
    } as unknown as HiaiDocsClient);
    try {
      for (const arguments_ of [
        { action: 'move', documentIds: [first], folderId: null },
        { action: 'set_category', documentIds: [first], categoryId: second },
        { action: 'remove_tag', documentIds: [first], tagId },
        { action: 'trash', documentIds: [first] },
        { action: 'restore', documentIds: [first] },
        { action: 'refresh_index', documentIds: [first] },
      ]) {
        const result = await session.client.callTool({ name: 'batch_documents', arguments: arguments_ });
        expect(structured(result)).toMatchObject({ total: 1, succeeded: 1, failed: 0, aborted: false });
      }
      expect(calls).toEqual([
        ['update', first, { folderId: null }],
        ['update', first, { categoryId: second }],
        ['remove_tag', first, tagId],
        ['trash', first],
        ['restore', first],
        ['refresh_index', first],
      ]);
    } finally { await session.close(); }
  });

  test('rejects duplicate IDs and more than 25 targets before mutation', async () => {
    let called = false;
    const session = await connected({ deleteDocument: async () => { called = true; } } as unknown as HiaiDocsClient);
    try {
      const duplicate = await session.client.callTool({ name: 'batch_documents', arguments: {
        action: 'trash', documentIds: [first, first],
      } });
      const oversized = await session.client.callTool({ name: 'batch_documents', arguments: {
        action: 'trash', documentIds: Array.from({ length: 26 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`),
      } });
      expect(duplicate.isError).toBe(true);
      expect(oversized.isError).toBe(true);
      expect(called).toBe(false);
    } finally { await session.close(); }
  });

  test('reads an authorized folder directly and categories or tags from scoped listings', async () => {
    const session = await connected({
      getFolder: async id => ({ id, ownerId: first, parentId: null, name: 'Folder', createdAt: '2026-09-28', updatedAt: '2026-09-28' }),
      listCategories: async () => [{ id: first, name: 'Category', order: 0, createdAt: '2026-09-28', updatedAt: '2026-09-28' }],
      listTags: async () => [{ id: second, name: 'Tag', color: null }],
    } as HiaiDocsClient);
    try {
      const folder = await session.client.callTool({ name: 'get_workspace_item', arguments: { kind: 'folder', id: first } });
      const category = await session.client.callTool({ name: 'get_workspace_item', arguments: { kind: 'category', id: first } });
      const tag = await session.client.callTool({ name: 'get_workspace_item', arguments: { kind: 'tag', id: second } });
      const absent = await session.client.callTool({ name: 'get_workspace_item', arguments: { kind: 'tag', id: first } });
      expect(structured(folder)).toMatchObject({ operation: 'folder', result: { id: first } });
      expect(structured(category)).toMatchObject({ operation: 'category', result: { id: first } });
      expect(structured(tag)).toMatchObject({ operation: 'tag', result: { id: second } });
      expect(absent.isError).toBe(true);
    } finally { await session.close(); }
  });
});
