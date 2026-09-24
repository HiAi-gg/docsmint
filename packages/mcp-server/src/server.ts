import { McpServer } from '@modelcontextprotocol/server';
import { z, type ZodRawShape } from 'zod';
import { isDocsApiError, type DocsClient, type DocsRequestContext } from '@hiai-docs/sdk';

import { registerLifecycleCapabilities } from './lifecycle.js';
import { registerExtendedCapabilities } from './capabilities.js';
import {
  createDefaultDocsClient,
  createMcpDocsClient,
  HiaiDocsError,
  type HiaiDocsClient,
} from './client.js';
import { toolOutputSchemas } from './output-schemas.js';
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

export { capabilityCatalog } from './capabilities.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;
interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function wrapHandler<Args>(
  name: string,
  handler: (args: Args) => Promise<unknown>,
  outputSchema?: z.ZodType
): (args: Args) => Promise<McpToolResult> {
  return async (args) => {
    try {
      const output = await handler(args);
      const parsedOutput = outputSchema ? await outputSchema.safeParseAsync(output) : undefined;
      if (parsedOutput && !parsedOutput.success) {
        throw new Error(`Tool '${name}' returned a result outside its published output schema`);
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        ...(parsedOutput?.success ? { structuredContent: parsedOutput.data } : {}),
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
      {
        description,
        inputSchema: z.object(inputSchema),
        annotations: {
          readOnlyHint: ![
            'create_document',
            'update_document',
            'create_folder',
            'create_snapshot',
          ].includes(name),
          destructiveHint: name === 'update_document',
          idempotentHint: ![
            'create_document',
            'update_document',
            'create_folder',
            'create_snapshot',
          ].includes(name),
          openWorldHint: false,
        },
        outputSchema: toolOutputSchemas[name as keyof typeof toolOutputSchemas],
      },
      wrapHandler(
        name,
        handler as ToolHandler,
        toolOutputSchemas[name as keyof typeof toolOutputSchemas]
      ) as never
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
  registerExtendedCapabilities(server, client, (name, handler) =>
    wrapHandler(name, handler, toolOutputSchemas[name as keyof typeof toolOutputSchemas])
  );
  registerLifecycleCapabilities(server, client, (name, handler) =>
    wrapHandler(name, handler, toolOutputSchemas[name as keyof typeof toolOutputSchemas])
  );
}

export interface CreateDocsmintMcpServerOptions {
  docsClient?: DocsClient;
  requestContext?: DocsRequestContext;
  /** @deprecated Inject a legacy capability client only for compatibility. */
  client?: HiaiDocsClient;
}

export function createDocsmintMcpServer(options: CreateDocsmintMcpServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'docsmint', version: '0.8.8' });
  const client = options.docsClient
    ? createMcpDocsClient(options.docsClient, options.requestContext)
    : options.client ?? createMcpDocsClient(createDefaultDocsClient(), options.requestContext);
  registerDocsmintMcpCapabilities(server, client);
  return server;
}
