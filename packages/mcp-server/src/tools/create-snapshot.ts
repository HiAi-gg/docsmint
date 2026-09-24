import { z } from 'zod';
import { client, type HiaiDocsClient } from '../client.js';
import type { Version } from '../types.js';

export const definition = {
  name: 'create_snapshot',
  description:
    'Save a named, retained snapshot of an existing document’s current content before a planned change. Requires edit access and adds an entry to get_version_history without changing the document itself. Use restore_document_version with the returned version ID to restore its content later.',
  inputSchema: {
    documentId: z
      .string()
      .uuid()
      .describe(
        'UUID of the existing document, obtained from search_documents or list_documents and visible in the active scope.'
      ),
    label: z
      .string()
      .min(1)
      .max(200)
      .describe("Non-empty snapshot label up to 200 characters, for example 'v1.0-release'."),
    description: z
      .string()
      .max(1000)
      .optional()
      .describe('Optional snapshot note up to 1,000 characters; omit if not needed.'),
  },
} as const;

export interface CreateSnapshotArgs {
  documentId: string;
  label: string;
  description?: string;
}

export const createHandler = (api: HiaiDocsClient) =>
  async function createSnapshot(args: CreateSnapshotArgs): Promise<Version> {
    const { documentId, ...input } = args;
    return (await api.createSnapshot(documentId, input)) as Version;
  };

export const handler = createHandler(client);
