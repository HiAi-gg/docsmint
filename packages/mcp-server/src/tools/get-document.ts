import { z } from 'zod';
import { client, type HiaiDocsClient } from '../client.js';
import type { DocumentDetail } from '../types.js';

export const definition = {
  name: 'get_document',
  description: 'Read one document with its content, metadata, and tags before editing or citing it. Requires read access. Use export_document when you only need portable Markdown.',
  inputSchema: {
    id: z.string().describe('Document ID.'),
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
