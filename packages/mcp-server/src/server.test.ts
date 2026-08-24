import { afterEach, describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { capabilityCatalog } from './capabilities.js';
import { client as defaultClient } from './client.js';
import { createDocsmintMcpServer } from './server.js';

describe('DocsMint MCP protocol discovery', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  test('advertises tools, prompts, and resources over MCP', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createDocsmintMcpServer();
    const client = new Client({ name: 'contract-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => {
      await client.close();
      await server.close();
    };

    const tools = await client.listTools();
    const prompts = await client.listPrompts();
    const resources = await client.listResources();
    const prompt = await client.getPrompt({
      name: 'research_workspace',
      arguments: { question: 'What changed?', language: 'English' },
    });
    const guide = await client.readResource({ uri: 'docsmint://guide/search' });

    expect(tools.tools.map((tool) => tool.name)).toEqual([...capabilityCatalog.tools]);
    expect(tools.tools).toHaveLength(17);
    expect(prompts.prompts.map((prompt) => prompt.name)).toEqual([
      'organize_workspace',
      'research_workspace',
    ]);
    expect(prompts.prompts).toHaveLength(2);
    expect(resources.resources.map((resource) => resource.uri)).toEqual([
      'docsmint://guide/editor',
      'docsmint://guide/search',
      'docsmint://workspace/catalog',
    ]);
    expect(resources.resources).toHaveLength(3);
    expect(prompt.messages[0]?.content).toMatchObject({
      type: 'text',
      text: expect.stringContaining('What changed?'),
    });
    expect(guide.contents[0]).toMatchObject({
      uri: 'docsmint://guide/search',
      text: expect.stringContaining('multilingual queries'),
    });
  });

  test('binds every capability to the injected scoped API client', async () => {
    const calls: string[] = [];
    const scopedClient = {
      ...defaultClient,
      search: async () => {
        calls.push('search');
        return { results: [{ id: 'document-scoped', title: 'Scoped result' }] };
      },
      listCategories: async () => {
        calls.push('categories');
        return [{ id: 'category-scoped', name: 'Scoped' }];
      },
      listFolders: async () => {
        calls.push('folders');
        return [{ id: 'folder-scoped', name: 'Scoped folder' }];
      },
      listTags: async () => {
        calls.push('tags');
        return [{ id: 'tag-scoped', name: 'Scoped tag' }];
      },
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createDocsmintMcpServer({ client: scopedClient });
    const client = new Client({ name: 'scoped-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => {
      await client.close();
      await server.close();
    };

    const categories = await client.callTool({
      name: 'list_categories',
      arguments: {},
    });
    const search = await client.callTool({
      name: 'search_documents',
      arguments: { query: 'scope' },
    });
    const catalog = await client.readResource({
      uri: 'docsmint://workspace/catalog',
    });

    expect(categories.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify([{ id: 'category-scoped', name: 'Scoped' }], null, 2),
      },
    ]);
    expect(catalog.contents[0]).toMatchObject({
      text: expect.stringContaining('folder-scoped'),
    });
    expect(search.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify(
          { results: [{ id: 'document-scoped', title: 'Scoped result' }] },
          null,
          2
        ),
      },
    ]);
    expect(calls).toEqual(['categories', 'search', 'categories', 'folders', 'tags']);
  });
});
