import { z } from 'zod';
import { client, type HiaiDocsClient } from '../client.js';
import type { ExportResponse } from '../types.js';

export const definition = {
  name: 'export_document',
  description:
    'Render one readable document as portable Markdown and return a markdown string in the response object. Does not modify the document or include its complete metadata; use get_document to inspect the editable document.',
  inputSchema: {
    id: z
      .string()
      .uuid()
      .describe(
        'UUID of the readable document to export, obtained from search_documents or list_documents.'
      ),
  },
} as const;

export interface ExportDocumentArgs {
  id: string;
}

export const createHandler = (api: HiaiDocsClient) =>
  async function exportDocument(args: ExportDocumentArgs): Promise<ExportResponse> {
    return (await api.exportDocument(args.id)) as ExportResponse;
  };

export const handler = createHandler(client);
