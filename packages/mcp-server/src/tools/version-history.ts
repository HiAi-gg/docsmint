import { z } from 'zod';
import { client, type HiaiDocsClient } from '../client.js';
import type { Version } from '../types.js';

export const definition = {
  name: 'get_version_history',
  description:
    'Read versions for an existing document, including saved snapshots. Requires read access and returns version IDs with content and timestamps; pass a version ID to restore_document_version when the user asks to restore content. This is read-only and does not change the document.',
  inputSchema: {
    documentId: z
      .string()
      .uuid()
      .describe(
        'UUID of the readable document whose version history you need; obtain it from search_documents or list_documents.'
      ),
    onlySnapshots: z
      .boolean()
      .optional()
      .describe(
        'When true, return only named snapshots and omit auto-saved revisions; omit or use false for the full history.'
      ),
  },
} as const;

export interface VersionHistoryArgs {
  documentId: string;
  onlySnapshots?: boolean;
}

export const createHandler = (api: HiaiDocsClient) =>
  async function getVersionHistory(args: VersionHistoryArgs): Promise<Version[]> {
    return (await api.getVersionHistory(args.documentId, args.onlySnapshots)) as Version[];
  };

export const handler = createHandler(client);
