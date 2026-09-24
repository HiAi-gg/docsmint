import { afterEach, describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { DocsClient } from '@hiai-docs/sdk';
import { execPath } from 'node:process';

import { capabilityCatalog } from './capabilities.js';
import { client as defaultClient } from './client.js';
import { capabilityCatalog as publicCapabilityCatalog, createDocsmintMcpServer } from './server.js';

describe('DocsMint MCP protocol discovery', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  test('exports the canonical catalog from the public MCP module', () => {
    expect(publicCapabilityCatalog).toEqual(capabilityCatalog);
  });

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
    expect(tools.tools).toHaveLength(capabilityCatalog.tools.length);
    const lobeManifest = await Bun.file(
      new URL('../../../lhm.plugin.json', import.meta.url)
    ).json();
    expect(lobeManifest.tools).toEqual(JSON.parse(JSON.stringify(tools.tools)));
    expect(lobeManifest.tools.map((tool: { name: string }) => tool.name)).toEqual([
      ...capabilityCatalog.tools,
    ]);
    for (const tool of tools.tools) {
      expect(tool.annotations?.readOnlyHint).toBeBoolean();
      for (const property of Object.values(tool.inputSchema.properties ?? {})) {
        expect((property as { description?: string }).description?.trim().length).toBeGreaterThan(
          10
        );
      }
    }
    expect(prompts.prompts.map((prompt) => prompt.name)).toEqual([...capabilityCatalog.prompts]);
    expect(prompts.prompts).toHaveLength(capabilityCatalog.prompts.length);
    expect(resources.resources.map((resource) => resource.uri)).toEqual([
      ...capabilityCatalog.resources,
    ]);
    expect(resources.resources).toHaveLength(capabilityCatalog.resources.length);
    expect(prompt.messages[0]?.content).toMatchObject({
      type: 'text',
      text: expect.stringContaining('What changed?'),
    });
    expect(guide.contents[0]).toMatchObject({
      uri: 'docsmint://guide/search',
      text: expect.stringContaining('multilingual queries'),
    });
  });

  test('stdio binary serves the canonical catalog and output schemas', async () => {
    const root = new URL('../../../', import.meta.url);
    const transport = new StdioClientTransport({
      command: execPath,
      args: ['run', 'packages/mcp-server/src/index.ts'],
      cwd: root.pathname,
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-contract-test', version: '1.0.0' });
    close = async () => {
      await client.close();
    };
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([...capabilityCatalog.tools]);
    expect(tools).toHaveLength(capabilityCatalog.tools.length);
    for (const tool of tools) expect(tool.outputSchema, tool.name).toBeDefined();
  });

  test('binds every capability to the injected scoped API client', async () => {
    const calls: string[] = [];
    const scopedClient = {
      ...defaultClient,
      search: async () => {
        calls.push('search');
        return {
          items: [
            {
              id: 'document-scoped',
              title: 'Scoped result',
              snippet: 'A scoped result',
              score: 0.9,
              folder_id: null,
              folder_name: null,
              created_at: '2026-09-24T00:00:00.000Z',
              updated_at: '2026-09-24T00:00:00.000Z',
            },
          ],
          total: 1,
          page: 1,
          limit: 20,
        };
      },
      listCategories: async () => {
        calls.push('categories');
        return [
          {
            id: 'category-scoped',
            name: 'Scoped',
            order: 0,
            apiMode: 'global',
            apiPermissionRead: true,
            apiPermissionEdit: true,
            apiPermissionWrite: true,
            createdAt: '2026-09-24T00:00:00.000Z',
            updatedAt: '2026-09-24T00:00:00.000Z',
          },
        ];
      },
      listFolders: async () => {
        calls.push('folders');
        return [{ id: 'folder-scoped', name: 'Scoped folder' }];
      },
      listTags: async () => {
        calls.push('tags');
        return [{ id: 'tag-scoped', name: 'Scoped tag', color: null }];
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
        text: JSON.stringify(
          [
            {
              id: 'category-scoped',
              name: 'Scoped',
              order: 0,
              apiMode: 'global',
              apiPermissionRead: true,
              apiPermissionEdit: true,
              apiPermissionWrite: true,
              createdAt: '2026-09-24T00:00:00.000Z',
              updatedAt: '2026-09-24T00:00:00.000Z',
            },
          ],
          null,
          2
        ),
      },
    ]);
    expect(catalog.contents[0]).toMatchObject({
      text: expect.stringContaining('folder-scoped'),
    });
    expect(search.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify(
          {
            items: [
              {
                id: 'document-scoped',
                title: 'Scoped result',
                snippet: 'A scoped result',
                score: 0.9,
                folder_id: null,
                folder_name: null,
                created_at: '2026-09-24T00:00:00.000Z',
                updated_at: '2026-09-24T00:00:00.000Z',
              },
            ],
            total: 1,
            page: 1,
            limit: 20,
          },
          null,
          2
        ),
      },
    ]);
    expect(calls).toEqual(['categories', 'search', 'categories', 'folders', 'tags']);
  });

  test('returns API-key category records without workspace permission metadata', async () => {
    const apiKeyCategory = {
      id: 'category-scoped',
      name: 'Scoped',
      order: 0,
      createdAt: '2026-09-24T00:00:00.000Z',
      updatedAt: '2026-09-24T00:00:00.000Z',
    };
    const scopedClient = {
      ...defaultClient,
      listCategories: async () => [apiKeyCategory],
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createDocsmintMcpServer({ client: scopedClient });
    const client = new Client({ name: 'api-key-category-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => {
      await client.close();
      await server.close();
    };

    const result = await client.callTool({ name: 'list_categories', arguments: {} });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ result: [apiKeyCategory] });
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify([apiKeyCategory], null, 2) },
    ]);
  });

  test('adapts a public DocsClient through one sanitized scoped context', async () => {
    const seenHeaders: Headers[] = [];
    const docsClient = new DocsClient({
      baseUrl: 'https://docs.example.test',
      apiKey: 'service-key',
      retries: 1,
      fetch: (async (_input, init) => {
        seenHeaders.push(new Headers(init?.headers));
        return Response.json([
          {
            id: 'category-scoped',
            name: 'Scoped',
            order: 0,
            apiMode: 'global',
            apiPermissionRead: true,
            apiPermissionEdit: true,
            apiPermissionWrite: true,
            createdAt: '2026-09-24T00:00:00.000Z',
            updatedAt: '2026-09-24T00:00:00.000Z',
          },
        ]);
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
          text: JSON.stringify(
            [
              {
                id: 'category-scoped',
                name: 'Scoped',
                order: 0,
                apiMode: 'global',
                apiPermissionRead: true,
                apiPermissionEdit: true,
                apiPermissionWrite: true,
                createdAt: '2026-09-24T00:00:00.000Z',
                updatedAt: '2026-09-24T00:00:00.000Z',
              },
            ],
            null,
            2
          ),
        },
      ],
    });
    expect(seenHeaders).toHaveLength(1);
    expect(seenHeaders[0]?.get('authorization')).toBe('Bearer service-key');
    expect(seenHeaders[0]?.get('cookie')).toBeNull();
    expect(seenHeaders[0]?.get('x-docsmint-workspace-context')).toBe('signed-workspace-assertion');
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
      "Tool 'list_categories' failed: spoofed failure"
    );
  });
});
