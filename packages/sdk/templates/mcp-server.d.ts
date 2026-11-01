import type { McpServer } from "@modelcontextprotocol/server";

import type { DocsClient, DocsRequestContext } from "./index.js";

export interface DocsMintMcpCapabilityCatalog {
	readonly tools: readonly string[];
	readonly prompts: readonly string[];
	readonly resources: readonly string[];
}

export declare const capabilityCatalog: DocsMintMcpCapabilityCatalog;

export interface HiaiDocsClient {
	deleteDocument?(id: string): Promise<void>;
	deleteFolder?(id: string): Promise<void>;
	deleteCategory?(id: string): Promise<void>;
	restoreDocumentVersion?(documentId: string, versionId: string): Promise<unknown>;
	search(params: { query: string; folder?: string; tags?: string[]; limit?: number }): Promise<unknown>;
	getDocument(id: string): Promise<unknown>;
	createDocument(input: { title?: string; content?: string; folderId?: string | null; categoryId?: string | null }): Promise<unknown>;
	updateDocument(id: string, input: { title?: string; content?: string; folderId?: string | null; categoryId?: string | null }): Promise<unknown>;
	listDocuments(params: { folderId?: string; tag?: string; page?: number; limit?: number }): Promise<unknown>;
	listFolders(params: { parentId?: string }): Promise<unknown>;
	createFolder(input: { name: string; parentId?: string | null; categoryId?: string | null }): Promise<unknown>;
	listCategories(): Promise<unknown>;
	createCategory(input: { name: string }): Promise<unknown>;
	listTags(): Promise<unknown>;
	getRelatedDocuments(documentId: string, limit?: number): Promise<unknown>;
	searchGraph(input: { query?: string; docIds: string[]; limit?: number }): Promise<unknown>;
	getDocumentIndexStatus(documentId: string): Promise<unknown>;
	refreshDocumentIndex(documentId: string): Promise<unknown>;
	createSnapshot(documentId: string, input: { label: string; description?: string }): Promise<unknown>;
	getVersionHistory(documentId: string, onlySnapshots?: boolean): Promise<unknown>;
	exportDocument(id: string): Promise<{ markdown: string; filename?: string }>;
}

export interface McpWorkspaceDescriptor {
  id: string;
  name: string;
  slug: string;
  entireWorkspace: boolean;
  categoryIds: string[];
}
export interface McpWorkspaceRouting {
  listWorkspaces(): Promise<McpWorkspaceDescriptor[]>;
  assertSelection(workspaceId: string): Promise<void>;
}
export declare function createMcpScopedResult(toolName: 'find_documents' | 'list_workspace_structure' | 'list_trash', input: unknown): unknown;

export interface CreateDocsmintMcpServerOptions {
	docsClient?: DocsClient;
	requestContext?: DocsRequestContext;
  workspaceRouting?: McpWorkspaceRouting;
	/** @deprecated Inject a legacy capability client only for compatibility. */
	client?: HiaiDocsClient;
}

export declare function registerDocsmintMcpCapabilities(
	server: McpServer,
	client: HiaiDocsClient,
  workspaceRouting?: McpWorkspaceRouting,
): void;

export declare function createDocsmintMcpServer(
	options?: CreateDocsmintMcpServerOptions,
): McpServer;
