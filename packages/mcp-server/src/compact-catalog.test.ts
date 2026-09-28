import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { capabilityCatalog, createDocsmintMcpServer } from './server.js';

const names = [
  'find_documents', 'read_document', 'save_document', 'delete_document',
  'list_workspace_structure', 'save_folder', 'delete_folder', 'save_category',
  'delete_category', 'save_tag', 'delete_tag', 'set_document_tag',
  'create_snapshot', 'restore_document_version', 'explore_graph',
  'get_document_index_status', 'refresh_document_index', 'list_trash',
  'restore_trashed_document', 'permanently_delete_document',
  'batch_documents', 'get_workspace_item',
] as const;

describe('compact MCP catalog', () => {
  test('advertises one 22-tool catalog with all existing prompts and resources', async () => {
    expect(capabilityCatalog.tools).toEqual(names);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createDocsmintMcpServer();
    const client = new Client({ name: 'compact-catalog-test', version: '1.0.0' });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([...names]);
      expect((await client.listPrompts()).prompts).toHaveLength(2);
      expect((await client.listResources()).resources).toHaveLength(3);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
