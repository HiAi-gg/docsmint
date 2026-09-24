import { afterEach, describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { DocsClient } from '@hiai-docs/sdk';
import { createDocsmintMcpServer } from './server.js';

const id = 'd1bf444e-15aa-42fe-9f58-687d479a16bd';
const versionId = 'e2bf444e-15aa-42fe-9f58-687d479a16bd';
const restoredDocument = {
  id,
  ownerId: 'owner-1',
  folderId: null,
  categoryId: null,
  title: 'Restored',
  content: 'Restored markdown',
  visibility: 'private',
  createdAt: '2026-09-24T00:00:00.000Z',
  updatedAt: '2026-09-24T00:00:00.000Z',
};
const operations = [
  ['delete_document', { id }, 'DELETE', `/api/documents/${id}`],
  ['delete_folder', { id }, 'DELETE', `/api/folders/${id}`],
  ['delete_category', { id }, 'DELETE', `/api/categories/${id}`],
  ['restore_document_version', { documentId: id, versionId }, 'POST', `/api/documents/${id}/versions/${versionId}/restore`],
] as const;

describe('MCP lifecycle contract', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());
  async function connect(fetcher: typeof fetch) {
    const docsClient = new DocsClient({ baseUrl: 'https://docs.example.test', apiKey: 'service-key', retries: 1, fetch: fetcher });
    const server = createDocsmintMcpServer({ docsClient, requestContext: {
      workspaceAssertion: 'signed-scope', authorization: 'Bearer untrusted', cookie: 'untrusted=1',
      headers: { Authorization: 'Bearer duplicate', Cookie: 'duplicate=1' },
    } });
    const client = new Client({ name: 'lifecycle-test', version: '1' });
    const [a,b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    close = async () => { await client.close(); await server.close(); };
    return client;
  }
  for (const [name, args, method, path] of operations) {
    test(`${name} forwards scope and returns a usable success response`, async () => {
      const requests: Array<{ url: string; method?: string; headers: Headers }> = [];
      const client = await connect((async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), method: init?.method, headers: new Headers(init?.headers) });
        return method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json(restoredDocument);
      }) as unknown as typeof fetch);
      const tools = await client.listTools();
      expect(tools.tools.find(t => t.name === name)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: expect.any(String) }]);
      expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual(
        method === 'DELETE' ? { id, deleted: true } : restoredDocument,
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('https://docs.example.test'+path);
      expect(requests[0]?.method).toBe(method);
      expect(requests[0]?.headers.get('authorization')).toBe('Bearer service-key');
      expect(requests[0]?.headers.get('cookie')).toBeNull();
      expect(requests[0]?.headers.get('x-docsmint-workspace-context')).toBe('signed-scope');
    });
    for (const status of [403,404]) test(`${name} preserves REST ${status} without reporting success`, async () => {
      const client = await connect((async () => Response.json({ error: status === 403 ? 'Forbidden' : 'Not found' }, { status })) as unknown as typeof fetch);
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text).status).toBe(status);
    });
    test(`${name} rejects malformed IDs before any REST mutation`, async () => {
      let calls = 0;
      const client = await connect((async () => { calls++; return Response.json({}); }) as unknown as typeof fetch);
      const result = await client.callTool({ name, arguments: name === 'restore_document_version' ? {documentId:id,versionId:'../escape'} : {id:'../escape'} });
      expect(result.isError).toBe(true);
      expect(calls).toBe(0);
    });
  }
});
