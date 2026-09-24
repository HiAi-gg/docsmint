import { z } from 'zod';
import { client, type HiaiDocsClient } from '../client.js';
import type { SearchResponse } from '../types.js';

export const definition = {
  name: 'search_documents',
  description:
    'Search readable DocsMint documents with hybrid full-text and semantic retrieval, optionally filtered by folder and tag names. Requires read access and stays within the active workspace/category. Use search_knowledge_graph for graph relations from seed documents or get_related_documents for neighbors without a text query.',
  inputSchema: {
    query: z
      .string()
      .describe(
        'Text to search for; preserve the language and terms relevant to the user request.'
      ),
    folder: z
      .string()
      .optional()
      .describe('Optional folder UUID from list_folders to scope retrieval.'),
    tags: z
      .array(z.string())
      .optional()
      .describe(
        'Optional tag names as shown by list_tags; documents match when they have any supplied tag name.'
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Maximum result count, from 1 to 100; defaults to 20.'),
  },
} as const;

export type SearchArgs = {
  query: string;
  folder?: string;
  tags?: string[];
  limit?: number;
};

export const createHandler = (api: HiaiDocsClient) =>
  async function searchDocuments(args: SearchArgs): Promise<SearchResponse> {
    return (await api.search({
      query: args.query,
      folder: args.folder,
      tags: args.tags,
      limit: args.limit,
    })) as SearchResponse;
  };

export const handler = createHandler(client);
