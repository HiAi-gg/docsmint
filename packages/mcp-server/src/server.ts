import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { isDocsApiError, type DocsClient, type DocsRequestContext } from '@hiai-docs/sdk';

import { registerCompactCapabilities } from './compact.js';
import { registerPromptsAndResources } from './prompts-resources.js';
import {
  createDefaultDocsClient,
  createMcpDocsClient,
  HiaiDocsError,
  type HiaiDocsClient,
} from './client.js';

export { capabilityCatalog } from './capabilities.js';

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
  registerCompactCapabilities(server, client, wrapHandler);
  registerPromptsAndResources(server, client);
}

export interface CreateDocsmintMcpServerOptions {
  docsClient?: DocsClient;
  requestContext?: DocsRequestContext;
  /** @deprecated Inject a legacy capability client only for compatibility. */
  client?: HiaiDocsClient;
}

export function createDocsmintMcpServer(options: CreateDocsmintMcpServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'docsmint', version: '0.10.0' });
  const client = options.docsClient
    ? createMcpDocsClient(options.docsClient, options.requestContext)
    : options.client ?? createMcpDocsClient(createDefaultDocsClient(), options.requestContext);
  registerDocsmintMcpCapabilities(server, client);
  return server;
}
