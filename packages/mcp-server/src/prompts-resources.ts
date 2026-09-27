import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { HiaiDocsClient } from './client.js';

export function registerPromptsAndResources(server: McpServer, client: HiaiDocsClient): void {
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
        text: '# DocsMint retrieval rules\n\nUse find_documents(mode=search) for normal retrieval. Use explore_graph only with document IDs already authorized by the active API key. Keep multilingual queries in their original language and cite document IDs in answers.',
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
