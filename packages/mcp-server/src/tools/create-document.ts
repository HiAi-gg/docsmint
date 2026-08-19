import { z } from "zod";
import { client } from "../client.js";
import type { DocumentDetail } from "../types.js";

export const definition = {
	name: "create_document",
	description:
		"Create a new document. Optionally provide initial markdown content and a folder ID.",
	inputSchema: {
		title: z.string().describe("Document title."),
		content: z
			.string()
			.optional()
			.describe("Initial markdown content for the document."),
		folderId: z
			.string()
			.optional()
			.describe("Optional folder ID to place the document in."),
		categoryId: z
			.string()
			.optional()
			.describe(
				"Optional category ID. Category keys are always rebound to their configured category.",
			),
	},
} as const;

export interface CreateDocumentArgs {
	title: string;
	content?: string;
	folderId?: string;
	categoryId?: string;
}

export async function handler(
	args: CreateDocumentArgs,
): Promise<DocumentDetail> {
	return (await client.createDocument(args)) as DocumentDetail;
}
