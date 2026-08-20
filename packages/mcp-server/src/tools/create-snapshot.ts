import { z } from 'zod';
import { client, type HiaiDocsClient } from '../client.js';
import type { Version } from '../types.js';

export const definition = {
  name: 'create_snapshot',
  description: 'Create a named snapshot (labelled version) of a document from its current content.',
  inputSchema: {
    documentId: z.string().describe('Document ID to snapshot.'),
    label: z.string().describe("Short label for the snapshot (e.g. 'v1.0-release')."),
    description: z.string().optional().describe('Optional longer description of the snapshot.'),
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
