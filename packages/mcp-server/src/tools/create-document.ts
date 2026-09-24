import { z } from 'zod';
import { client, type HiaiDocsClient } from '../client.js';
import type { DocumentDetail } from '../types.js';

export const definition = {
  name: 'create_document',
  description:
    'Create a new DocsMint document when no existing document should be modified. Optionally set a title, initial Markdown content, and folder or category placement; an omitted title defaults to “Untitled”. Requires write access in the target scope. A category-scoped credential must create inside its configured category, by selecting that category or a folder within it. Normal creation schedules indexing asynchronously and returns the created document. Use update_document for an existing document.',
  inputSchema: {
    title: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe('Optional title from 1 to 500 characters; omit to use the API default “Untitled”.'),
    content: z
      .string()
      .optional()
      .describe('Optional initial Markdown content; omit to create an empty document.'),
    folderId: z
      .string()
      .uuid()
      .optional()
      .describe(
        'Optional folder UUID from list_folders; the folder must be writable in the active workspace or category.'
      ),
    categoryId: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .describe(
        'Optional category UUID from list_categories; omit or pass null to leave the explicit category unset. A categorized folder still supplies the document’s effective category; without one the document remains uncategorized. Category-scoped credentials stay bound to their configured category.'
      ),
  },
} as const;

export interface CreateDocumentArgs {
  title?: string;
  content?: string;
  folderId?: string;
  categoryId?: string | null;
}

export const createHandler = (api: HiaiDocsClient) =>
  async function createDocument(args: CreateDocumentArgs): Promise<DocumentDetail> {
    return (await api.createDocument(args)) as DocumentDetail;
  };

export const handler = createHandler(client);
