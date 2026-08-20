import { z } from 'zod';
import { client, type HiaiDocsClient } from '../client.js';
import type { Folder } from '../types.js';

export const definition = {
  name: 'list_folders',
  description:
    'List folders, optionally scoped to a parent folder. Returns a flat list of immediate children.',
  inputSchema: {
    parentId: z
      .string()
      .optional()
      .describe('Optional parent folder ID. Omit to list top-level (root) folders.'),
  },
} as const;

export interface ListFoldersArgs {
  parentId?: string;
}

export const createHandler = (api: HiaiDocsClient) =>
  async function listFolders(args: ListFoldersArgs): Promise<Folder[]> {
    return (await api.listFolders(args)) as Folder[];
  };

export const handler = createHandler(client);
