import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { HiaiDocsClient } from './client.js';

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
  ] as const,
  prompts: ['organize_workspace', 'research_workspace'] as const,
  resources: [
    'docsmint://guide/editor',
    'docsmint://guide/search',
    'docsmint://workspace/catalog',
  ] as const,
};

type TextResult = { content: Array<{ type: 'text'; text: string }> };

function jsonResult(value: unknown): TextResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function registerExtendedCapabilities(server: McpServer, client: HiaiDocsClient): void {
  server.registerTool(
    'list_categories',
    {
      description:
        'List categories visible to the API key. Category keys receive only their bound category.',
      inputSchema: z.object({}),
    },
    async () => jsonResult(await client.listCategories())
  );
  server.registerTool(
    'create_category',
    {
      description:
        'Create a category. Requires a workspace key with write access; category keys cannot mutate categories.',
      inputSchema: z.object({
        name: z.string().min(1),
        description: z.string().optional(),
      }),
    },
    async (input) => jsonResult(await client.createCategory(input))
  );
  server.registerTool(
    'list_tags',
    {
      description: 'List tags visible in the workspace or bound category.',
      inputSchema: z.object({}),
    },
    async () => jsonResult(await client.listTags())
  );
  server.registerTool(
    'get_related_documents',
    {
      description: 'Traverse the knowledge graph from one authorized document.',
      inputSchema: z.object({
        documentId: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    },
    async ({ documentId, limit }) => jsonResult(await client.getRelatedDocuments(documentId, limit))
  );
  server.registerTool(
    'search_knowledge_graph',
    {
      description:
        'Search connected knowledge using authorized seed documents. Category keys may use only documents in their category.',
      inputSchema: z.object({
        query: z.string().min(1).max(1000),
        docIds: z.array(z.string().min(1)).min(1),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    },
    async (input) => jsonResult(await client.searchGraph(input))
  );
  server.registerTool(
    'get_document_index_status',
    {
      description: 'Read the current indexing and knowledge-pipeline status of a document.',
      inputSchema: z.object({ documentId: z.string().min(1) }),
    },
    async ({ documentId }) => jsonResult(await client.getDocumentIndexStatus(documentId))
  );
  server.registerTool(
    'refresh_document_index',
    {
      description: 'Request reindexing after a document or metadata change. Requires write access.',
      inputSchema: z.object({ documentId: z.string().min(1) }),
    },
    async ({ documentId }) => jsonResult(await client.refreshDocumentIndex(documentId))
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
