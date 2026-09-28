import { afterEach, describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { capabilityCatalog } from './capabilities.js';
import { createDocsmintMcpServer } from './server.js';

const readOnly = new Set([
  'find_documents', 'read_document', 'list_workspace_structure', 'explore_graph',
  'get_document_index_status', 'list_trash',
  'get_workspace_item',
]);
const destructive = new Set([
  'save_document', 'delete_document', 'save_folder', 'delete_folder',
  'save_category', 'delete_category', 'save_tag', 'delete_tag',
  'set_document_tag', 'restore_document_version', 'permanently_delete_document',
  'batch_documents',
]);

describe('DocsMint MCP tool definitions', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  async function listTools() {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createDocsmintMcpServer();
    const client = new Client({ name: 'definition-quality-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => { await client.close(); await server.close(); };
    return (await client.listTools()).tools;
  }

  test('publishes exactly one meaningful tool per compact capability', async () => {
    const tools = await listTools();
    expect(tools.map(tool => tool.name)).toEqual([...capabilityCatalog.tools]);
    for (const tool of tools) {
      expect(tool.description?.length, tool.name).toBeGreaterThan(45);
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.annotations).toMatchObject({
        readOnlyHint: readOnly.has(tool.name),
        destructiveHint: destructive.has(tool.name),
        openWorldHint: false,
      });
      const variants = (tool.inputSchema as { oneOf?: Array<{ properties?: Record<string, unknown> }> }).oneOf ?? [tool.inputSchema];
      for (const variant of variants) {
        for (const [name, property] of Object.entries(variant.properties ?? {})) {
          const description = typeof property === 'object' && property !== null
            ? (property as { description?: unknown }).description
            : undefined;
          expect(typeof description === 'string' ? description.length : 0, `${tool.name}.${name}`).toBeGreaterThan(10);
        }
      }
    }
  });

  test('discriminated operations document when to browse, search, create, and update', async () => {
    const tools = await listTools();
    const description = (name: string) => tools.find(tool => tool.name === name)?.description ?? '';
    expect(description('find_documents')).toContain('mode=list');
    expect(description('find_documents')).toContain('mode=search');
    expect(description('read_document')).toContain('markdown');
    expect(description('save_document')).toContain('action=create');
    expect(description('save_document')).toContain('action=update');
    expect(description('list_workspace_structure')).toContain('categories');
    expect(description('set_document_tag')).toContain('action=remove');
    expect(description('explore_graph')).toContain('mode=neighbors');
    expect(description('restore_document_version')).toContain('read_document(view=versions)');
    expect(description('restore_trashed_document')).toContain('restore_document_version');
    expect(description('get_document_index_status')).toContain('refresh_document_index');
  });

  test('explains when to choose one-document tools or a batch', async () => {
    const tools = await listTools();
    const description = (name: string) => tools.find(tool => tool.name === name)?.description ?? '';
    expect(description('batch_documents')).toContain('multiple');
    expect(description('batch_documents')).toContain('one document');
    expect(description('batch_documents')).toContain('partial success');
    expect(description('save_document')).toContain('one document');
    expect(description('delete_document')).toContain('one document');
    expect(description('set_document_tag')).toContain('one document');
    expect(description('refresh_document_index')).toContain('one document');
    expect(description('restore_trashed_document')).toContain('one document');
  });

  test('grouped inputs and outputs expose explicit variants', async () => {
    const tools = await listTools();
    const variants = new Map([
      ['find_documents', 2], ['read_document', 3], ['save_document', 2],
      ['list_workspace_structure', 3], ['save_folder', 2], ['save_category', 2],
      ['save_tag', 2], ['explore_graph', 2],
    ]);
    for (const [name, count] of variants) {
      const tool = tools.find(entry => entry.name === name);
      expect(tool, name).toBeDefined();
      expect((tool?.inputSchema as { oneOf?: unknown[] })?.oneOf, `${name} input variants`).toHaveLength(count);
      expect((tool?.outputSchema as { anyOf?: unknown[] })?.anyOf, `${name} output variants`).toHaveLength(count);
    }
  });
});
