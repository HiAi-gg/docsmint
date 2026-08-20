import { z } from 'zod';
import { client, type HiaiDocsClient } from '../client.js';
import type { SearchResponse } from '../types.js';

export const definition = {
  name: 'search_documents',
  description:
    'Hybrid search across documents (full-text + semantic). Supports filtering by folder and tags.',
  inputSchema: {
    query: z.string().describe('Search query string.'),
    folder: z.string().optional().describe('Optional folder ID to scope the search to.'),
    tags: z.array(z.string()).optional().describe('Optional tag IDs to filter by.'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum number of results to return (default 20).'),
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
