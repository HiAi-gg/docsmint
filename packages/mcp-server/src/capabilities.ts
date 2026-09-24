import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { HiaiDocsClient } from './client.js';
import { toolOutputSchemas } from './output-schemas.js';

export const capabilityCatalog = {
  tools: [
    'search_documents',
    'get_document',
    'create_document',
    'update_document',
    'list_documents',
    'list_folders',
    'create_folder',
    'create_snapshot',
    'get_version_history',
    'export_document',
    'list_categories',
    'create_category',
    'list_tags',
    'get_related_documents',
    'search_knowledge_graph',
    'get_document_index_status',
    'refresh_document_index',
    'delete_document',
    'delete_folder',
    'delete_category',
    'restore_document_version',
  ] as const,
  prompts: ['organize_workspace', 'research_workspace'] as const,
  resources: [
    'docsmint://guide/editor',
    'docsmint://guide/search',
    'docsmint://workspace/catalog',
  ] as const,
};

type ToolWrapper = <Args>(
  name: string,
  handler: (args: Args) => Promise<unknown>
) => (args: Args) => Promise<unknown>;

export function registerExtendedCapabilities(
  server: McpServer,
  client: HiaiDocsClient,
  wrapHandler: ToolWrapper
): void {
  server.registerTool(
    'list_categories',
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        'List categories visible in the active workspace or category scope. Requires read access; a category-scoped credential sees only its configured category. Use this before create_document or create_folder when you need an existing category ID.',
      inputSchema: z.object({}),
      outputSchema: toolOutputSchemas.list_categories,
    },
    wrapHandler('list_categories', async () => client.listCategories()) as never
  );
  server.registerTool(
    'create_category',
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      description:
        'Create a new category for the active workspace. Requires workspace-level write access; category-scoped credentials cannot create categories. Returns the created category. Use list_categories to inspect existing categories.',
      inputSchema: z.object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .describe('Non-empty display name, up to 255 characters, for example Project notes.'),
      }),
      outputSchema: toolOutputSchemas.create_category,
    },
    wrapHandler('create_category', async (input: { name: string }) =>
      client.createCategory(input)
    ) as never
  );
  server.registerTool(
    'list_tags',
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        'List tags visible in the active workspace or configured category scope. Requires read access; use returned tag IDs to filter list_documents and returned tag names to filter search_documents.',
      inputSchema: z.object({}),
      outputSchema: toolOutputSchemas.list_tags,
    },
    wrapHandler('list_tags', async () => client.listTags()) as never
  );
  server.registerTool(
    'get_related_documents',
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        'Traverse graph relations from one readable document without a text query. Requires read access and returns related document IDs plus relation metadata. Use search_knowledge_graph to rank graph neighbors with query text, or search_documents for normal hybrid retrieval. Results stay in the active scope and may be empty when graph data is unavailable.',
      inputSchema: z.object({
        documentId: z
          .string()
          .min(1)
          .describe(
            'Document ID returned by search_documents or list_documents; it must be readable in the active scope.'
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe(
            'Maximum related documents to return, from 1 to 100. Omit to use the server default.'
          ),
      }),
      outputSchema: toolOutputSchemas.get_related_documents,
    },
    wrapHandler(
      'get_related_documents',
      async ({ documentId, limit }: { documentId: string; limit?: number }) =>
        client.getRelatedDocuments(documentId, limit)
    ) as never
  );
  server.registerTool(
    'search_knowledge_graph',
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        'Search graph relations from one or more readable seed documents, optionally using query text to filter and rank related documents. Requires read access and returns seed entities plus relatedDocs. Use search_documents first to obtain authorized seed IDs; use get_related_documents for one-seed neighbors without graph search. Results stay in the active scope and graph data may be empty when unavailable.',
      inputSchema: z.object({
        query: z
          .string()
          .max(2000)
          .optional()
          .describe(
            'Optional search text up to 2,000 characters to filter and rank graph-related documents; omit it to inspect relations without query filtering.'
          ),
        docIds: z
          .array(z.string().min(1))
          .min(1)
          .max(50)
          .describe(
            'Between 1 and 50 document IDs returned by search_documents or list_documents; each seed must be readable in the active scope.'
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe(
            'Maximum related documents to return, from 1 to 100. Omit to use the server default.'
          ),
      }),
      outputSchema: toolOutputSchemas.search_knowledge_graph,
    },
    wrapHandler(
      'search_knowledge_graph',
      async (input: { query?: string; docIds: string[]; limit?: number }) =>
        client.searchGraph(input)
    ) as never
  );
  server.registerTool(
    'get_document_index_status',
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        'Read indexing and knowledge-pipeline status for an existing document without starting work. Requires read access. Use after a save or refresh_document_index to check progress or failures.',
      inputSchema: z.object({
        documentId: z
          .string()
          .uuid()
          .describe(
            'UUID of a document returned by search_documents or list_documents; it must be readable in the active scope.'
          ),
      }),
      outputSchema: toolOutputSchemas.get_document_index_status,
    },
    wrapHandler('get_document_index_status', async ({ documentId }: { documentId: string }) =>
      client.getDocumentIndexStatus(documentId)
    ) as never
  );
  server.registerTool(
    'refresh_document_index',
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      description:
        'Queue an explicit reindex for an existing document; processing is asynchronous and the response acknowledges the generation. Requires write access. Normal content and placement changes schedule indexing when needed, so use get_document_index_status first and refresh only when a retry is intended.',
      inputSchema: z.object({
        documentId: z
          .string()
          .uuid()
          .describe(
            'UUID of the document to refresh, obtained from search_documents or list_documents and visible in the active scope.'
          ),
      }),
      outputSchema: toolOutputSchemas.refresh_document_index,
    },
    wrapHandler('refresh_document_index', async ({ documentId }: { documentId: string }) =>
      client.refreshDocumentIndex(documentId)
    ) as never
  );

  server.registerPrompt(
    'organize_workspace',
    {
      description: 'Plan safe document organization using DocsMint categories and folders.',
      argsSchema: z.object({
        objective: z.string(),
        language: z.string().optional(),
      }),
    },
    ({ objective, language }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Organize this DocsMint workspace for: ${objective}. Work in ${language ?? 'the document language'}. Inspect categories, folders, tags, and documents before proposing or applying changes. Preserve document content and obey the API key scope.`,
          },
        },
      ],
    })
  );
  server.registerPrompt(
    'research_workspace',
    {
      description:
        'Research a question with hybrid search and GraphRAG while citing DocsMint document IDs.',
      argsSchema: z.object({
        question: z.string(),
        language: z.string().optional(),
      }),
    },
    ({ question, language }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Answer this question from DocsMint: ${question}. Respond in ${language ?? 'the question language'}. Start with hybrid search, use graph traversal only from authorized result documents, and cite document IDs. Distinguish retrieved facts from inference.`,
          },
        },
      ],
    })
  );

  server.registerResource('editor-guide', 'docsmint://guide/editor', {}, async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'text/markdown',
        text: '# DocsMint editing rules\n\nRead a document before updating it. Preserve its language, title intent, TipTap/Markdown structure, category, folder, and tags unless the user explicitly requests a change. After content changes, verify index status and request refresh only when needed.',
      },
    ],
  }));
  server.registerResource('search-guide', 'docsmint://guide/search', {}, async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'text/markdown',
        text: '# DocsMint retrieval rules\n\nUse search_documents for normal retrieval. Use get_related_documents or search_knowledge_graph only with document IDs already authorized by the active API key. Keep multilingual queries in their original language and cite document IDs in answers.',
      },
    ],
  }));
  server.registerResource('workspace-catalog', 'docsmint://workspace/catalog', {}, async (uri) => {
    const [categories, folders, tags] = await Promise.all([
      client.listCategories(),
      client.listFolders({}),
      client.listTags(),
    ]);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({ categories, folders, tags }, null, 2),
        },
      ],
    };
  });
}
