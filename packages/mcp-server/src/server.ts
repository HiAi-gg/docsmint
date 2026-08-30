import { McpServer } from '@modelcontextprotocol/server';
import { z, type ZodRawShape } from 'zod';
import { isDocsApiError, type DocsClient, type DocsRequestContext } from '@hiai-docs/sdk';

import { registerExtendedCapabilities } from './capabilities.js';
import {
  createDefaultDocsClient,
  createMcpDocsClient,
  HiaiDocsError,
  type HiaiDocsClient,
} from './client.js';
import * as createDocument from './tools/create-document.js';
import * as createFolder from './tools/create-folder.js';
import * as createSnapshot from './tools/create-snapshot.js';
import * as exportDocument from './tools/export-document.js';
import * as getDocument from './tools/get-document.js';
import * as listDocuments from './tools/list-documents.js';
import * as listFolders from './tools/list-folders.js';
import * as search from './tools/search.js';
import * as updateDocument from './tools/update-document.js';
import * as versionHistory from './tools/version-history.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;
interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function wrapHandler<Args>(
  name: string,
  handler: (args: Args) => Promise<unknown>
): (args: Args) => Promise<McpToolResult> {
  return async (args) => {
    try {
      return {
        content: [{ type: 'text', text: JSON.stringify(await handler(args), null, 2) }],
      };
    } catch (error) {
      if (isDocsApiError(error) || error instanceof HiaiDocsError) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                type: error.name,
                status: error.status,
                code: error.code,
                message: error.message,
                body: error.body,
              }),
            },
          ],
        };
      }
      return {
        isError: true,
        content: [{ type: 'text', text: `Tool '${name}' failed: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  };
}

export function registerDocsmintMcpCapabilities(server: McpServer, client: HiaiDocsClient): void {
  const register = <Args>(
    name: string,
    description: string,
    inputSchema: ZodRawShape,
    handler: (args: Args) => Promise<unknown>
  ): void => {
    server.registerTool(
      name,
      { description, inputSchema: z.object(inputSchema) },
      wrapHandler(name, handler as ToolHandler) as never
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
      tool.createHandler(client) as ToolHandler
    );
  }
  registerExtendedCapabilities(server, client, (handler) => wrapHandler('extended', handler));
}

export interface CreateDocsmintMcpServerOptions {
  docsClient?: DocsClient;
  requestContext?: DocsRequestContext;
  /** @deprecated Inject a legacy capability client only for compatibility. */
  client?: HiaiDocsClient;
}

export function createDocsmintMcpServer(options: CreateDocsmintMcpServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'docsmint', version: '0.7.8' });
  const client = options.docsClient
    ? createMcpDocsClient(options.docsClient, options.requestContext)
    : options.client ?? createMcpDocsClient(createDefaultDocsClient(), options.requestContext);
  registerDocsmintMcpCapabilities(server, client);
  return server;
}
