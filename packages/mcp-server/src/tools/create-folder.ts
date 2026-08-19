import { z } from "zod";
import { client } from "../client.js";
import type { Folder } from "../types.js";

export const definition = {
	name: "create_folder",
	description: "Create a new folder, optionally nested under a parent folder.",
	inputSchema: {
		name: z.string().describe("Folder name."),
		parentId: z
			.string()
			.optional()
			.describe("Optional parent folder ID for nesting."),
		categoryId: z
			.string()
			.optional()
			.describe(
				"Optional category ID. Category keys are always rebound to their configured category.",
			),
	},
} as const;

export interface CreateFolderArgs {
	name: string;
	parentId?: string;
	categoryId?: string;
}

export async function handler(args: CreateFolderArgs): Promise<Folder> {
	return (await client.createFolder(args)) as Folder;
}
