import { z } from 'zod';
import { client, type HiaiDocsClient } from '../client.js';
import type { Folder } from '../types.js';

export const definition = {
  name: 'create_folder',
  description:
    'Create a new folder in the active workspace or category scope. Requires write access and returns the created folder. A nested folder inherits its parent category; for a root folder, pass categoryId when using a category-scoped credential. Category-scoped credentials cannot create outside their configured category.',
  inputSchema: {
    name: z.string().min(1).max(255).describe('Non-empty folder name up to 255 characters.'),
    parentId: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .describe(
        'Optional parent folder UUID from list_folders; omit or pass null to create a root-level folder.'
      ),
    categoryId: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .describe(
        'Optional category UUID from list_categories for a root-level folder. A nested folder inherits its parent category; category-scoped credentials cannot escape their configured category.'
      ),
  },
} as const;

export interface CreateFolderArgs {
  name: string;
  parentId?: string | null;
  categoryId?: string | null;
}

export const createHandler = (api: HiaiDocsClient) =>
  async function createFolder(args: CreateFolderArgs): Promise<Folder> {
    return (await api.createFolder(args)) as Folder;
  };

export const handler = createHandler(client);
