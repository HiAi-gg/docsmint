import type { McpServer } from '@modelcontextprotocol/server';
import { DocsMintMcpServer } from './argument-diagnostics.js';
import { z } from 'zod';
import { isDocsApiError, type DocsClient, type DocsRequestContext } from '@hiai-docs/sdk';

import type { McpWorkspaceRouting } from './workspace-routing.js';
export type { McpWorkspaceDescriptor, McpWorkspaceRouting } from './workspace-routing.js';
export { createMcpScopedResult } from './output-schemas.js';

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
  outputSchema?: z.ZodType,
  workspaceRouting?: McpWorkspaceRouting,
  decorateResult?: (tool: string, output: unknown) => unknown | Promise<unknown>
): (args: Args) => Promise<McpToolResult> {
  return async (args) => {
    try {
      const { workspaceId, ...data } = args as Record<string, unknown>;
      if (workspaceId !== undefined) {
        if (!workspaceRouting) throw new Error('Workspace routing is not configured');
        await workspaceRouting.assertSelection(workspaceId as string);
      }
      let output: unknown;
      if (name === 'list_workspace_structure' && data.kind === 'workspaces') {
        if (!workspaceRouting) throw new Error('Workspace routing is not configured');
        const workspaces = await workspaceRouting.listWorkspaces();
        output = { operation: 'workspaces', result: workspaceId ? workspaces.filter(item => item.id === workspaceId) : workspaces };
      } else {
        output = await handler(data as Args);
      }
      if (decorateResult) output = await decorateResult(name, output);
      const parsedOutput = outputSchema ? await outputSchema.safeParseAsync(output) : undefined;
      if (parsedOutput && !parsedOutput.success) {
        throw new Error(`Tool '${name}' returned a result outside its published output schema`);
      }
      const result = parsedOutput?.success ? parsedOutput.data : output;
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
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

export function registerDocsmintMcpCapabilities(server: McpServer, client: HiaiDocsClient, workspaceRouting?: McpWorkspaceRouting, decorateResult?: (tool: string, output: unknown) => unknown | Promise<unknown>): void {
  const wrap: typeof wrapHandler = (name, handler, outputSchema) => wrapHandler(name, handler, outputSchema, workspaceRouting, decorateResult);
  registerCompactCapabilities(server, client, wrap);
  registerPromptsAndResources(server, client);
}

export interface CreateDocsmintMcpServerOptions {
  docsClient?: Omit<DocsClient, "withRequestContext">;
  /** Trusted host-only presentation hook, applied before output schema validation. */
  decorateResult?: (tool: string, output: unknown) => unknown | Promise<unknown>;
  requestContext?: DocsRequestContext;
  workspaceRouting?: McpWorkspaceRouting;
  /** @deprecated Inject a legacy capability client only for compatibility. */
  client?: HiaiDocsClient;
}

export function createDocsmintMcpServer(options: CreateDocsmintMcpServerOptions = {}): McpServer {
  const server = new DocsMintMcpServer({ name: 'docsmint', version: '2.1.3' });
  const client = options.docsClient
    ? createMcpDocsClient(options.docsClient, options.requestContext)
    : options.client ?? createMcpDocsClient(createDefaultDocsClient(), options.requestContext);
  registerDocsmintMcpCapabilities(server, client, options.workspaceRouting, options.decorateResult);
  return server;
}

export { generateDocsmintMcpCatalog, type DocsMintMcpDocumentationCatalog } from './catalog.js';
export { createDocsmintMcpHttpHandler, type DocsmintMcpHttpOptions } from './http.js';
