import { describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpScopedResult, createDocsmintMcpServer } from './server.js';
import type { HiaiDocsClient } from './client.js';

const emptyWorkspace = { id: '11111111-1111-4111-8111-111111111111', name: 'Empty fixture', slug: 'empty-fixture', entireWorkspace: true, categoryIds: [] };
const other = { ...emptyWorkspace, id: '22222222-2222-4222-8222-222222222222', name: 'Other fixture', slug: 'other-fixture' };
async function connected(routing?: unknown, impl: object = {}) {
  const server = createDocsmintMcpServer({ client: impl as HiaiDocsClient, workspaceRouting: routing } as never);
  const client = new Client({ name: 'workspace-routing-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const routing = { listWorkspaces: async () => [emptyWorkspace, other], assertSelection: async (id: string) => { if (id !== emptyWorkspace.id) throw new Error('Outside the bound workspace'); } };

describe('public MCP workspace routing', () => {
  test('discovers empty granted workspaces without listing categories', async () => {
    const s = await connected(routing);
    try {
      const result = await s.client.callTool({ name: 'list_workspace_structure', arguments: { kind: 'workspaces' } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ operation: 'workspaces', result: [emptyWorkspace, other] });
    } finally { await s.close(); }
  });
  test('publishes an optional UUID selector on all 22 tool schemas', async () => {
    const s = await connected(routing);
    try {
      const tools = (await s.client.listTools()).tools;
      expect(tools).toHaveLength(22);
      for (const tool of tools) {
        const schema = tool.inputSchema as { properties: Record<string, unknown> };
        expect(schema.properties.workspaceId, tool.name).toMatchObject({ type: 'string', format: 'uuid' });
      }
    } finally { await s.close(); }
  });
  test('validates the selected scope and strips metadata before data operations', async () => {
    let received: unknown;
    const s = await connected(routing, { listFolders: async (input: unknown) => { received = input; return []; } });
    try {
      const result = await s.client.callTool({ name: 'list_workspace_structure', arguments: { kind: 'folders', workspaceId: emptyWorkspace.id } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ operation: 'folders', result: [] });
      expect(received).toEqual({ parentId: undefined });
      const denied = await s.client.callTool({ name: 'list_workspace_structure', arguments: { kind: 'folders', workspaceId: other.id } });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied.content)).toContain('Outside the bound workspace');
    } finally { await s.close(); }
  });
  test('rejects selectors without a host hook instead of silently ignoring them', async () => {
    const s = await connected(undefined, { listCategories: async () => [] });
    try {
      const result = await s.client.callTool({ name: 'list_workspace_structure', arguments: { kind: 'categories', workspaceId: emptyWorkspace.id } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('Workspace routing is not configured');
      const legacy = await s.client.callTool({ name: 'list_workspace_structure', arguments: { kind: 'categories' } });
      expect(legacy.isError).not.toBe(true);
      expect(legacy.structuredContent).toEqual({ operation: 'categories', result: [] });
    } finally { await s.close(); }
  });
});


test('scoped results validate nested data and keep empty workspaces and per-scope pages', () => {
 const scopedResults = [emptyWorkspace, other].map((workspace, index) => ({ workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug }, categoryId: null, data: { operation: 'list', result: { items: [], total: index ? 30 : 0, page: 2, limit: 10 } } }));
 expect(createMcpScopedResult('find_documents', { operation: 'list', scopedResults })).toEqual({ operation: 'list', scopedResults });
 expect(() => createMcpScopedResult('find_documents', { operation: 'list', scopedResults: [{ ...scopedResults[0], data: { operation: 'list', result: { items: [] } } }] })).toThrow();
});

test('rejects invalid selectors before reaching any operation and filters workspace discovery', async () => {
 const s = await connected(routing);
 try {
  const invalid = await s.client.callTool({ name: 'list_workspace_structure', arguments: { kind: 'workspaces', workspaceId: 'not-a-uuid' } });
  expect(invalid.isError).toBe(true);
  const selected = await s.client.callTool({ name: 'list_workspace_structure', arguments: { kind: 'workspaces', workspaceId: emptyWorkspace.id } });
  expect(selected.structuredContent).toEqual({ operation: 'workspaces', result: [emptyWorkspace] });
 } finally { await s.close(); }
});


test('workspace selectors remain visible in each operation branch used by client schema normalizers', async () => {
  const s = await connected(routing, { listCategories: async () => [] });
  try {
    const tools = (await s.client.listTools()).tools;
    let branchesChecked = 0;
    for (const tool of tools) {
      const schema = tool.inputSchema as { properties: Record<string, unknown>; oneOf?: Array<{ properties: Record<string, unknown>; required?: string[] }> };
      for (const branch of schema.oneOf ?? []) {
        expect(branch.properties.workspaceId, `${tool.name}: operation branch selector`).toEqual(schema.properties.workspaceId);
        expect(branch.required ?? []).not.toContain('workspaceId');
        branchesChecked++;
      }
    }
    expect(branchesChecked).toBeGreaterThan(0);
    const schema = tools.find(tool => tool.name === 'list_workspace_structure')!.inputSchema as unknown as { oneOf: Array<{ properties: Record<string, { const?: string }> }> };
    const branch = schema.oneOf.find(item => item.properties.kind?.const === 'categories')!;
    // Clients render and normalize the selected operation's declared fields.
    const input = { kind: 'categories', workspaceId: emptyWorkspace.id };
    const visibleArguments = Object.fromEntries(Object.entries(input).filter(([key]) => key in branch.properties));
    const result = await s.client.callTool({ name: 'list_workspace_structure', arguments: visibleArguments });
    expect(result.structuredContent).toEqual({ operation: 'categories', result: [] });
  } finally { await s.close(); }
});
