import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";

import { registerExtendedCapabilities } from "./capabilities.js";
import { HiaiDocsError } from "./client.js";
import * as createDocument from "./tools/create-document.js";
import * as createFolder from "./tools/create-folder.js";
import * as createSnapshot from "./tools/create-snapshot.js";
import * as exportDocument from "./tools/export-document.js";
import * as getDocument from "./tools/get-document.js";
import * as listDocuments from "./tools/list-documents.js";
import * as listFolders from "./tools/list-folders.js";
import * as search from "./tools/search.js";
import * as updateDocument from "./tools/update-document.js";
import * as versionHistory from "./tools/version-history.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;
interface McpToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

function wrapHandler(
	name: string,
	handler: ToolHandler,
): (args: Record<string, unknown>) => Promise<McpToolResult> {
	return async (args) => {
		try {
			return {
				content: [
					{ type: "text", text: JSON.stringify(await handler(args), null, 2) },
				],
			};
		} catch (error) {
			const message =
				error instanceof HiaiDocsError
					? `DocsMint API error (${error.status}): ${error.message}`
					: `Tool '${name}' failed: ${error instanceof Error ? error.message : String(error)}`;
			return { isError: true, content: [{ type: "text", text: message }] };
		}
	};
}

export function createDocsmintMcpServer(): McpServer {
	const server = new McpServer({ name: "docsmint", version: "0.6.0" });
	const register = <Args>(
		name: string,
		description: string,
		inputSchema: ZodRawShape,
		handler: (args: Args) => Promise<unknown>,
	): void => {
		server.tool(
			name,
			description,
			inputSchema as never,
			wrapHandler(name, handler as ToolHandler) as never,
		);
	};

	const tools = [
		search,
		getDocument,
		createDocument,
		updateDocument,
		listDocuments,
		listFolders,
		createFolder,
		createSnapshot,
		versionHistory,
		exportDocument,
	] as const;
	for (const tool of tools) {
		register(
			tool.definition.name,
			tool.definition.description,
			tool.definition.inputSchema as ZodRawShape,
			tool.handler as ToolHandler,
		);
	}
	registerExtendedCapabilities(server);
	return server;
}
