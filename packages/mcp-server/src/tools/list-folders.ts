import { z } from 'zod';
import { client, type HiaiDocsClient } from '../client.js';
import type { Folder } from '../types.js';

export const definition = {
  name: 'list_folders',
  description:
    'List folders readable in the active workspace/category. Omit parentId to list root folders, or supply a parent UUID to list its immediate children as a flat list. Use create_folder to add a folder.',
  inputSchema: {
    parentId: z
      .string()
      .uuid()
      .optional()
      .describe('Optional parent folder UUID from list_folders; omit to list root folders.'),
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
