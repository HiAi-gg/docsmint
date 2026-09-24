import { z } from 'zod';
import { client, type HiaiDocsClient } from '../client.js';
import type { ListDocumentsResponse } from '../types.js';

export const definition = {
  name: 'list_documents',
  description:
    'List readable documents in the active workspace or category with page-based results. Optionally filter by folder or tag; page defaults to 1 and limit to 20 (maximum 1,000). Use search_documents for text or semantic retrieval.',
  inputSchema: {
    folderId: z
      .string()
      .uuid()
      .optional()
      .describe('Optional folder UUID from list_folders to limit the listing.'),
    tag: z
      .string()
      .uuid()
      .optional()
      .describe('Optional tag UUID from list_tags to filter the documents.'),
    page: z.number().int().min(1).optional().describe('1-indexed result page; defaults to 1.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe('Number of documents per page, from 1 to 1,000; defaults to 20.'),
  },
} as const;

export interface ListDocumentsArgs {
  folderId?: string;
  tag?: string;
  page?: number;
  limit?: number;
}

export const createHandler = (api: HiaiDocsClient) =>
  async function listDocuments(args: ListDocumentsArgs): Promise<ListDocumentsResponse> {
    return (await api.listDocuments(args)) as ListDocumentsResponse;
  };

export const handler = createHandler(client);
