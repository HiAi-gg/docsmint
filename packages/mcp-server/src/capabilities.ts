import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { client } from "./client.js";

export const capabilityCatalog = {
	tools: [
		"search_documents",
		"get_document",
		"create_document",
		"update_document",
		"list_documents",
		"list_folders",
		"create_folder",
		"create_snapshot",
		"get_version_history",
		"export_document",
		"list_categories",
		"create_category",
		"list_tags",
		"get_related_documents",
		"search_knowledge_graph",
		"get_document_index_status",
		"refresh_document_index",
	] as const,
	prompts: ["organize_workspace", "research_workspace"] as const,
	resources: [
		"docsmint://guide/editor",
		"docsmint://guide/search",
		"docsmint://workspace/catalog",
	] as const,
};

type TextResult = { content: Array<{ type: "text"; text: string }> };

function jsonResult(value: unknown): TextResult {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function registerExtendedCapabilities(server: McpServer): void {
	server.tool(
		"list_categories",
		"List categories visible to the API key. Category keys receive only their bound category.",
		{},
		async () => jsonResult(await client.listCategories()),
	);
	server.tool(
		"create_category",
		"Create a category. Requires a workspace key with write access; category keys cannot mutate categories.",
		{ name: z.string().min(1), description: z.string().optional() },
		async (input) => jsonResult(await client.createCategory(input)),
	);
	server.tool(
		"list_tags",
		"List tags visible in the workspace or bound category.",
		{},
		async () => jsonResult(await client.listTags()),
	);
	server.tool(
		"get_related_documents",
		"Traverse the knowledge graph from one authorized document.",
		{
			documentId: z.string().min(1),
			limit: z.number().int().min(1).max(50).optional(),
		},
		async ({ documentId, limit }) =>
			jsonResult(await client.getRelatedDocuments(documentId, limit)),
	);
	server.tool(
		"search_knowledge_graph",
		"Search connected knowledge using authorized seed documents. Category keys may use only documents in their category.",
		{
			query: z.string().min(1).max(1000),
			docIds: z.array(z.string().min(1)).min(1),
			limit: z.number().int().min(1).max(50).optional(),
		},
		async (input) => jsonResult(await client.searchGraph(input)),
	);
	server.tool(
		"get_document_index_status",
		"Read the current indexing and knowledge-pipeline status of a document.",
		{ documentId: z.string().min(1) },
		async ({ documentId }) =>
			jsonResult(await client.getDocumentIndexStatus(documentId)),
	);
	server.tool(
		"refresh_document_index",
		"Request reindexing after a document or metadata change. Requires write access.",
		{ documentId: z.string().min(1) },
		async ({ documentId }) =>
			jsonResult(await client.refreshDocumentIndex(documentId)),
	);

	server.prompt(
		"organize_workspace",
		"Plan safe document organization using DocsMint categories and folders.",
		{ objective: z.string(), language: z.string().optional() },
		({ objective, language }) => ({
			messages: [
				{
					role: "user",
					content: {
						type: "text",
						text: `Organize this DocsMint workspace for: ${objective}. Work in ${language ?? "the document language"}. Inspect categories, folders, tags, and documents before proposing or applying changes. Preserve document content and obey the API key scope.`,
					},
				},
			],
		}),
	);
	server.prompt(
		"research_workspace",
		"Research a question with hybrid search and GraphRAG while citing DocsMint document IDs.",
		{ question: z.string(), language: z.string().optional() },
		({ question, language }) => ({
			messages: [
				{
					role: "user",
					content: {
						type: "text",
						text: `Answer this question from DocsMint: ${question}. Respond in ${language ?? "the question language"}. Start with hybrid search, use graph traversal only from authorized result documents, and cite document IDs. Distinguish retrieved facts from inference.`,
					},
				},
			],
		}),
	);

	server.resource("editor-guide", "docsmint://guide/editor", async (uri) => ({
		contents: [
			{
				uri: uri.href,
				mimeType: "text/markdown",
				text: "# DocsMint editing rules\n\nRead a document before updating it. Preserve its language, title intent, TipTap/Markdown structure, category, folder, and tags unless the user explicitly requests a change. After content changes, verify index status and request refresh only when needed.",
			},
		],
	}));
	server.resource("search-guide", "docsmint://guide/search", async (uri) => ({
		contents: [
			{
				uri: uri.href,
				mimeType: "text/markdown",
				text: "# DocsMint retrieval rules\n\nUse search_documents for normal retrieval. Use get_related_documents or search_knowledge_graph only with document IDs already authorized by the active API key. Keep multilingual queries in their original language and cite document IDs in answers.",
			},
		],
	}));
	server.resource(
		"workspace-catalog",
		"docsmint://workspace/catalog",
		async (uri) => {
			const [categories, folders, tags] = await Promise.all([
				client.listCategories(),
				client.listFolders({}),
				client.listTags(),
			]);
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: "application/json",
						text: JSON.stringify({ categories, folders, tags }, null, 2),
					},
				],
			};
		},
	);
}
