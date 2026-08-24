import { afterEach, describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { DocsClient } from '@hiai-docs/sdk';

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

  test('adapts a public DocsClient through one sanitized scoped context', async () => {
    const seenHeaders: Headers[] = [];
    const docsClient = new DocsClient({
      baseUrl: 'https://docs.example.test',
      apiKey: 'service-key',
      retries: 1,
      fetch: (async (_input, init) => {
        seenHeaders.push(new Headers(init?.headers));
        return Response.json([{ id: 'category-scoped', name: 'Scoped' }]);
      }) as typeof fetch,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createDocsmintMcpServer({
      docsClient,
      requestContext: {
        workspaceAssertion: 'signed-workspace-assertion',
        authorization: 'Bearer caller-token',
        cookie: 'caller-cookie=secret',
        headers: {
          Authorization: 'Bearer duplicate-caller-token',
          Cookie: 'duplicate-caller-cookie=secret',
        },
        requestId: 'req-mcp',
        idempotencyKey: 'idem-mcp',
      },
    });
    const client = new Client({ name: 'public-sdk-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => {
      await client.close();
      await server.close();
    };

    const result = await client.callTool({ name: 'list_categories', arguments: {} });

    expect(result).toMatchObject({
      content: [
        {
          type: 'text',
          text: JSON.stringify([{ id: 'category-scoped', name: 'Scoped' }], null, 2),
        },
      ],
    });
    expect(seenHeaders).toHaveLength(1);
    expect(seenHeaders[0]?.get('authorization')).toBe('Bearer service-key');
    expect(seenHeaders[0]?.get('cookie')).toBeNull();
    expect(seenHeaders[0]?.get('x-docsmint-workspace-context')).toBe(
      'signed-workspace-assertion'
    );
    expect(seenHeaders[0]?.get('x-request-id')).toBe('req-mcp');
    expect(seenHeaders[0]?.get('idempotency-key')).toBe('idem-mcp');
  });

  test('returns DocsApiError details as structured MCP error JSON', async () => {
    const docsClient = new DocsClient({
      baseUrl: 'https://docs.example.test',
      retries: 1,
      fetch: (async () =>
        Response.json(
          { error: 'Forbidden category', code: 'workspace_forbidden' },
          { status: 403 }
        )) as unknown as typeof fetch,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createDocsmintMcpServer({ docsClient });
    const client = new Client({ name: 'error-contract-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => {
      await client.close();
      await server.close();
    };

    const result = await client.callTool({ name: 'list_categories', arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? '')).toEqual({
      type: 'DocsApiError',
      status: 403,
      code: 'workspace_forbidden',
      message: 'Forbidden category',
      body: { error: 'Forbidden category', code: 'workspace_forbidden' },
    });
  });

  test('does not classify an unbranded error with copied fields as DocsApiError', async () => {
    const spoofedError = Object.assign(new Error('spoofed failure'), {
      name: 'DocsApiError',
      status: 403,
      code: 'workspace_forbidden',
      body: { error: 'spoofed' },
    });
    const docsClient = {
      listCategories: async () => {
        throw spoofedError;
      },
    } as never;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createDocsmintMcpServer({ client: docsClient });
    const client = new Client({ name: 'spoof-contract-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => {
      await client.close();
      await server.close();
    };

    const result = await client.callTool({ name: 'list_categories', arguments: {} });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe(
      "Tool 'extended' failed: spoofed failure"
    );
  });
});
