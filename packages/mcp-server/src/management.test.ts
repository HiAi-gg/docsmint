import { afterEach, describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { DocsClient } from '@hiai-docs/sdk';
import { createDocsmintMcpServer } from './server.js';

const id = 'd1bf444e-15aa-42fe-9f58-687d479a16bd';
const tagId = 'e2bf444e-15aa-42fe-9f58-687d479a16bd';
const tag = { id: tagId, name: 'Research', color: null };
const folder = { id, name: 'Renamed', ownerId: 'owner', parentId: null, order: 0, createdAt: '', updatedAt: '' };
const category = { id, name: 'Renamed', order: 0, apiMode: 'global', apiPermissionRead: true, apiPermissionEdit: true, apiPermissionWrite: true, createdAt: '', updatedAt: '' };
const operations = [
  ['create_tag', { name: 'Research' }, 'POST', '/api/tags', tag],
  ['update_tag', { id: tagId, name: 'Research' }, 'PATCH', `/api/tags/${tagId}`, tag],
  ['delete_tag', { id: tagId }, 'DELETE', `/api/tags/${tagId}`, { id: tagId, deleted: true }],
  ['add_tag_to_document', { documentId: id, tagId }, 'POST', `/api/documents/${id}/tags`, { documentId: id, tagId, assigned: true }],
  ['remove_tag_from_document', { documentId: id, tagId }, 'DELETE', `/api/documents/${id}/tags/${tagId}`, { documentId: id, tagId, removed: true }],
  ['update_folder', { id, name: 'Renamed' }, 'PATCH', `/api/folders/${id}`, folder],
  ['update_category', { id, name: 'Renamed' }, 'PATCH', `/api/categories/${id}`, category],
  ['list_trash', {}, 'GET', '/api/trash', { documents: [], folders: [] }],
  ['restore_trashed_document', { id }, 'POST', `/api/trash/documents/${id}/restore`, { success: true }],
  ['permanently_delete_document', { id }, 'DELETE', `/api/trash/documents/${id}`, { id, deleted: true }],
] as const;

describe('MCP management operations', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());
  async function connect(fetcher: typeof fetch) {
    const docsClient = new DocsClient({ baseUrl: 'https://docs.example.test', apiKey: 'service-key', retries: 1, fetch: fetcher });
    const server = createDocsmintMcpServer({ docsClient, requestContext: {
      workspaceAssertion: 'signed-scope', authorization: 'Bearer untrusted', cookie: 'untrusted=1',
      headers: { Authorization: 'Bearer duplicate', Cookie: 'duplicate=1' },
    } });
    const client = new Client({ name: 'management-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    close = async () => { await client.close(); await server.close(); };
    return client;
  }

  for (const [name, args, method, path, expected] of operations) {
    test(`${name} forwards scoped REST request and returns its result`, async () => {
      const requests: Array<{ url: string; method?: string; headers: Headers; body?: string }> = [];
      const client = await connect((async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), method: init?.method, headers: new Headers(init?.headers), body: init?.body as string | undefined });
        if (name === 'permanently_delete_document') return Response.json({ success: true });
        return method === 'DELETE' || name === 'add_tag_to_document' ? new Response(null, { status: 204 }) : Response.json(expected);
      }) as unknown as typeof fetch);
      expect((await client.listTools()).tools.some(tool => tool.name === name)).toBe(true);
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual(expected);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(`https://docs.example.test${path}`);
      expect(requests[0]?.method).toBe(method);
      expect(requests[0]?.headers.get('authorization')).toBe('Bearer service-key');
      expect(requests[0]?.headers.get('cookie')).toBeNull();
      expect(requests[0]?.headers.get('x-docsmint-workspace-context')).toBe('signed-scope');
      if (name === 'create_tag') expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({ name: 'Research' });
      if (name === 'add_tag_to_document') expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({ tagId });
      if (name === 'update_folder' || name === 'update_category') expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({ name: 'Renamed' });
    });
    test(`${name} reports API denial`, async () => {
      const client = await connect((async () => Response.json({ error: 'Forbidden' }, { status: 403 })) as unknown as typeof fetch);
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
    });
    if (name !== 'list_trash') test(`${name} validates identifiers and required fields before REST`, async () => {
      let calls = 0;
      const client = await connect((async () => { calls++; return Response.json(expected); }) as unknown as typeof fetch);
      const invalid = name === 'create_tag' ? { name: '' }
        : name === 'add_tag_to_document' || name === 'remove_tag_from_document'
          ? { documentId: '../escape', tagId }
          : { ...args, id: '../escape' };
      expect((await client.callTool({ name, arguments: invalid })).isError).toBe(true);
      expect(calls).toBe(0);
    });
  }
});
