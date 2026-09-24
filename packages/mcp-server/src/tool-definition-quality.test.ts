import { afterEach, describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { capabilityCatalog } from './capabilities.js';
import { createDocsmintMcpServer } from './server.js';

const annotations = {
  search_documents: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  get_document: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  create_document: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  update_document: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  list_documents: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  list_folders: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  create_folder: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  create_snapshot: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  get_version_history: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  export_document: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  list_categories: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  create_category: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  list_tags: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  get_related_documents: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  search_knowledge_graph: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  get_document_index_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  refresh_document_index: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  delete_document: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  delete_folder: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  delete_category: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  restore_document_version: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
} as const;

describe('DocsMint MCP tool definitions', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  async function listTools() {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createDocsmintMcpServer();
    const client = new Client({ name: 'definition-quality-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => {
      await client.close();
      await server.close();
    };
    return (await client.listTools()).tools;
  }

  test('every advertised tool has a purpose, described parameters, and truthful effect hints', async () => {
    const tools = await listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect(tools.map((tool) => tool.name)).toEqual([...capabilityCatalog.tools]);
    expect(byName.size).toBe(capabilityCatalog.tools.length);
    for (const name of capabilityCatalog.tools) {
      const tool = byName.get(name);
      expect(tool?.description?.trim().length, `${name} description`).toBeGreaterThan(24);
      expect(tool?.annotations, `${name} annotations`).toMatchObject({
        ...annotations[name],
        openWorldHint: false,
      });
      for (const [propertyName, property] of Object.entries(tool?.inputSchema.properties ?? {})) {
        expect(
          (property as { description?: string }).description?.trim().length,
          `${name}.${propertyName} parameter description`
        ).toBeGreaterThan(10);
      }
    }
  });

  test('related tools explain when to choose each sibling', async () => {
    const tools = await listTools();
    const description = (name: string) =>
      tools.find((tool) => tool.name === name)?.description ?? '';

    expect(description('search_documents')).toContain('hybrid');
    expect(description('search_documents')).toContain('search_knowledge_graph');
    expect(description('get_related_documents')).toContain('without a text query');
    expect(description('get_related_documents')).toContain('search_knowledge_graph');
    expect(description('search_knowledge_graph')).toContain('search_documents');
    expect(description('create_document')).toContain('update_document');
    expect(description('update_document')).toContain('create_document');
    expect(description('get_document')).toContain('export_document');
    expect(description('export_document')).toContain('get_document');
    expect(description('get_document_index_status')).toContain('refresh_document_index');
    expect(description('refresh_document_index')).toContain('get_document_index_status');
    expect(description('get_version_history')).toContain('restore_document_version');
    expect(description('restore_document_version')).toContain('get_version_history');
  });

  test('document mutations describe create, patch, placement, history, and indexing semantics', async () => {
    const tools = await listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const create = byName.get('create_document');
    const update = byName.get('update_document');

    expect(create?.description).toContain('no existing document');
    expect(create?.description).toContain('write');
    expect(create?.description).toContain('category');
    expect(create?.description).toContain('index');
    expect(update?.description).toContain('existing document');
    expect(update?.description).toContain('read');
    expect(update?.description).toContain('Omitted fields remain unchanged');
    expect(update?.description).toContain('null');
    expect(update?.description).toContain('version history');
    expect(update?.description).toContain('index');
    expect(update?.description).toContain('category');
    expect(create?.inputSchema.properties?.categoryId).toMatchObject({
      description: expect.stringContaining('categorized folder'),
    });
    expect(update?.inputSchema.properties?.categoryId).toMatchObject({
      description: expect.stringContaining('effective category'),
    });
  });

  test('input limits and UUID formats match the REST operations', async () => {
    const tools = await listTools();
    const properties = (name: string) =>
      tools.find((tool) => tool.name === name)?.inputSchema.properties ?? {};
    const containsUuidValidator = (schema: unknown): boolean => {
      if (!schema || typeof schema !== 'object') return false;
      const candidate = schema as { format?: string; pattern?: string };
      if (candidate.format === 'uuid') return true;
      if (
        candidate.pattern &&
        new RegExp(candidate.pattern).test('d1bf444e-15aa-42fe-9f58-687d479a16bd')
      ) {
        return true;
      }
      return Object.values(schema).some((value) =>
        Array.isArray(value) ? value.some(containsUuidValidator) : containsUuidValidator(value)
      );
    };
    const isUuid = (name: string, property: string) =>
      containsUuidValidator(properties(name)[property]);
    const containsConstraint = (schema: unknown, key: string, expected: number): boolean => {
      if (!schema || typeof schema !== 'object') return false;
      if ((schema as Record<string, unknown>)[key] === expected) return true;
      return Object.values(schema).some((value) =>
        Array.isArray(value)
          ? value.some((entry) => containsConstraint(entry, key, expected))
          : containsConstraint(value, key, expected)
      );
    };
    const hasConstraint = (name: string, property: string, key: string, expected: number) =>
      containsConstraint(properties(name)[property], key, expected);

    expect(isUuid('create_document', 'folderId')).toBe(true);
    expect(isUuid('create_document', 'categoryId')).toBe(true);
    expect(isUuid('update_document', 'id')).toBe(true);
    expect(isUuid('update_document', 'folderId')).toBe(true);
    expect(isUuid('list_documents', 'folderId')).toBe(true);
    expect(isUuid('list_documents', 'tag')).toBe(true);
    expect(hasConstraint('create_document', 'title', 'maxLength', 500)).toBe(true);
    expect(hasConstraint('update_document', 'title', 'maxLength', 500)).toBe(true);
    expect(
      (tools.find((tool) => tool.name === 'create_document')?.inputSchema.required ??
        []) as string[]
    ).not.toContain('title');
    expect(hasConstraint('list_documents', 'limit', 'maximum', 1000)).toBe(true);
    expect(hasConstraint('search_documents', 'limit', 'maximum', 100)).toBe(true);
  });

  test('MCP inputs preserve canonical REST semantics for categories and search tags', async () => {
    const tools = await listTools();
    const category = tools.find((tool) => tool.name === 'create_category');
    const search = tools.find((tool) => tool.name === 'search_documents');
    const categoryProperties = category?.inputSchema.properties ?? {};
    const searchProperties = search?.inputSchema.properties ?? {};
    const tagItems = searchProperties.tags as
      { items?: { format?: string; description?: string } } | undefined;

    expect(categoryProperties).not.toHaveProperty('description');
    expect(tagItems?.items?.format).toBeUndefined();
    expect(searchProperties.tags).toMatchObject({
      description: expect.stringContaining('any supplied tag name'),
    });
  });

  test('every tool publishes a stable output schema', async () => {
    const tools = await listTools();
    for (const tool of tools) {
      expect(tool.outputSchema, `${tool.name} output schema`).toBeDefined();
    }

    const listCategorySchema = tools.find((tool) => tool.name === 'list_categories')?.outputSchema;
    const createCategorySchema = tools.find((tool) => tool.name === 'create_category')?.outputSchema;
    const listCategorySchemaJson = listCategorySchema as unknown as
      | {
          properties?: {
            result?: { items?: { anyOf?: Array<{ required?: string[] }> } };
          };
        }
      | undefined;
    const listItems = listCategorySchemaJson?.properties?.result
      ?.items?.anyOf;
    const fullCategoryRequired = createCategorySchema?.required as string[] | undefined;

    expect(listItems).toHaveLength(2);
    expect(listItems?.map((variant) => variant.required ?? [])).toContainEqual(
      expect.arrayContaining(['apiMode', 'apiPermissionRead', 'apiPermissionEdit', 'apiPermissionWrite'])
    );
    expect(listItems?.map((variant) => variant.required ?? [])).toContainEqual(
      expect.not.arrayContaining(['apiMode', 'apiPermissionRead', 'apiPermissionEdit', 'apiPermissionWrite'])
    );
    expect(fullCategoryRequired).toEqual(
      expect.arrayContaining(['apiMode', 'apiPermissionRead', 'apiPermissionEdit', 'apiPermissionWrite'])
    );
  });

  test('stable deletion acknowledgments publish and return structured content', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createDocsmintMcpServer({
      client: {
        deleteDocument: async () => undefined,
        deleteFolder: async () => undefined,
        deleteCategory: async () => undefined,
      } as never,
    });
    const client = new Client({ name: 'output-schema-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => {
      await client.close();
      await server.close();
    };

    const tools = await client.listTools();
    for (const name of ['delete_document', 'delete_folder', 'delete_category']) {
      const tool = tools.tools.find((entry) => entry.name === name);
      expect(tool?.outputSchema, `${name} output schema`).toBeDefined();
      const result = await client.callTool({
        name,
        arguments: { id: 'd1bf444e-15aa-42fe-9f58-687d479a16bd' },
      });
      expect(result.structuredContent).toEqual({
        id: 'd1bf444e-15aa-42fe-9f58-687d479a16bd',
        deleted: true,
      });
    }
  });
});
