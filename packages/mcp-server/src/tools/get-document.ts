import { z } from 'zod';
import { client, type HiaiDocsClient } from '../client.js';
import type { DocumentDetail } from '../types.js';

export const definition = {
  name: 'get_document',
  description:
    'Read an existing document by UUID with its content, metadata, and tags before editing or citing it. Requires read access in the active workspace/category. Use export_document when you only need the portable Markdown body.',
  inputSchema: {
    id: z
      .string()
      .uuid()
      .describe(
        'UUID of the document, obtained from search_documents or list_documents, and visible in the active scope.'
      ),
  },
} as const;

export interface GetDocumentArgs {
  id: string;
}

export const createHandler = (api: HiaiDocsClient) =>
  async function getDocument(args: GetDocumentArgs): Promise<DocumentDetail> {
    return (await api.getDocument(args.id)) as DocumentDetail;
  };

export const handler = createHandler(client);
