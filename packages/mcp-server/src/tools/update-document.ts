import { z } from 'zod';
import { client, type HiaiDocsClient } from '../client.js';
import type { DocumentDetail } from '../types.js';

export const definition = {
  name: 'update_document',
  description:
    "Update an existing document's title and/or content. The server creates a new version on each update.",
  inputSchema: {
    id: z.string().describe('Document ID to update.'),
    title: z.string().optional().describe('New title for the document.'),
    content: z.string().optional().describe('New markdown content for the document.'),
    folderId: z.string().nullable().optional().describe('Move the document to a folder.'),
    categoryId: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Move the document to a category. Category keys cannot escape their configured category.'
      ),
  },
} as const;

export interface UpdateDocumentArgs {
  id: string;
  title?: string;
  content?: string;
  folderId?: string | null;
  categoryId?: string | null;
}

export const createHandler = (api: HiaiDocsClient) =>
  async function updateDocument(args: UpdateDocumentArgs): Promise<DocumentDetail> {
    const { id, ...patch } = args;
    return (await api.updateDocument(id, patch)) as DocumentDetail;
  };

export const handler = createHandler(client);
