#!/usr/bin/env bun
/**
 * hiai-docs MCP Server
 *
 * Exposes hiai-docs operations as MCP tools via the stdio transport.
 *
 * Environment:
 *   HIAI_DOCS_URL      — base URL of the hiai-docs API
 *                        (default: http://localhost:50700)
 *   HIAI_DOCS_API_KEY  — bearer token used for Authorization header
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HiaiDocsError } from "./client.js";
import type { ZodRawShape } from "zod";

import * as search from "./tools/search.js";
import * as getDocument from "./tools/get-document.js";
import * as createDocument from "./tools/create-document.js";
import * as updateDocument from "./tools/update-document.js";
import * as listDocuments from "./tools/list-documents.js";
import * as listFolders from "./tools/list-folders.js";
import * as createFolder from "./tools/create-folder.js";
import * as createSnapshot from "./tools/create-snapshot.js";
import * as versionHistory from "./tools/version-history.js";
import * as exportDocument from "./tools/export-document.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const server = new McpServer({
	name: "hiai-docs",
	version: "0.2.8",
});

/**
 * Wraps a tool handler to convert errors into MCP-formatted responses.
 * The SDK's tool callback returns CallToolResult; we return either success
 * with JSON-stringified content or an error with `isError: true`.
 */
function wrapHandler(
  name: string,
  handler: ToolHandler,
): (args: Record<string, unknown>) => Promise<McpToolResult> {
  return async (args) => {
    try {
      const result = await handler(args);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      if (err instanceof HiaiDocsError) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `hiai-docs API error (${err.status}): ${err.message}`,
            },
          ],
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Tool '${name}' failed: ${message}`,
          },
        ],
      };
    }
  };
}

function register<Args>(
  name: string,
  description: string,
  inputSchema: ZodRawShape,
  handler: (args: Args) => Promise<unknown>,
): void {
  server.tool(name, description, inputSchema as never, wrapHandler(name, handler as ToolHandler) as never);
}

register(search.definition.name, search.definition.description, search.definition.inputSchema as ZodRawShape, search.handler);
register(getDocument.definition.name, getDocument.definition.description, getDocument.definition.inputSchema as ZodRawShape, getDocument.handler);
register(createDocument.definition.name, createDocument.definition.description, createDocument.definition.inputSchema as ZodRawShape, createDocument.handler);
register(updateDocument.definition.name, updateDocument.definition.description, updateDocument.definition.inputSchema as ZodRawShape, updateDocument.handler);
register(listDocuments.definition.name, listDocuments.definition.description, listDocuments.definition.inputSchema as ZodRawShape, listDocuments.handler);
register(listFolders.definition.name, listFolders.definition.description, listFolders.definition.inputSchema as ZodRawShape, listFolders.handler);
register(createFolder.definition.name, createFolder.definition.description, createFolder.definition.inputSchema as ZodRawShape, createFolder.handler);
register(createSnapshot.definition.name, createSnapshot.definition.description, createSnapshot.definition.inputSchema as ZodRawShape, createSnapshot.handler);
register(versionHistory.definition.name, versionHistory.definition.description, versionHistory.definition.inputSchema as ZodRawShape, versionHistory.handler);
register(exportDocument.definition.name, exportDocument.definition.description, exportDocument.definition.inputSchema as ZodRawShape, exportDocument.handler);

const transport = new StdioServerTransport();

await server.connect(transport);
