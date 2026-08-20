import { z } from 'zod';
import { client, type HiaiDocsClient } from '../client.js';
import type { ExportResponse } from '../types.js';

export const definition = {
  name: 'export_document',
  description: 'Export a document as markdown. Returns the rendered markdown content.',
  inputSchema: {
    id: z.string().describe('Document ID to export.'),
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
