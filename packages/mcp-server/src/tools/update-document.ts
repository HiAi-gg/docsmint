import { z } from 'zod';
import { client, type HiaiDocsClient } from '../client.js';
import type { DocumentDetail } from '../types.js';

export const definition = {
  name: 'update_document',
  description:
    'Modify an existing document by UUID after reading its current state. Omitted fields remain unchanged; null folderId removes folder placement and null categoryId clears the explicit category, while a categorized folder can still supply the effective category. Changing title or Markdown content requires edit access, while moving placement requires write access in the active workspace/category. The server stores the prior content in version history and queues indexing when content or placement changes. Returns the updated document. Use create_document for new content.',
  inputSchema: {
    id: z
      .string()
      .uuid()
      .describe(
        'UUID of the existing document, obtained from search_documents, list_documents, or get_document.'
      ),
    title: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'Optional replacement title, 1 to 500 characters; omit to leave the current title unchanged.'
      ),
    content: z.string().optional().describe('New markdown content for the document.'),
    folderId: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .describe(
        'Optional destination folder UUID from list_folders; omit to keep current placement or pass null to remove folder placement.'
      ),
    categoryId: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .describe(
        'Optional destination category UUID from list_categories; omit to keep the explicit category or pass null to clear it. A categorized folder may still supply the effective category. Category-scoped credentials cannot move outside their configured category.'
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
