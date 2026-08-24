/**
 * Compatibility adapter from the public DocsClient to the MCP capability
 * surface. The MCP server has no independent REST transport.
 */

import { DocsClient, type DocsRequestContext } from "@hiai-docs/sdk";

import type { ExportResponse } from "./types.js";

const DEFAULT_BASE_URL = "http://localhost:50700";

function readConfig(): { baseUrl: string; apiKey?: string } {
	const baseUrl = (process.env.HIAI_DOCS_URL ?? DEFAULT_BASE_URL).replace(
		/\/+$/,
		"",
	);
	const apiKey = process.env.HIAI_DOCS_API_KEY;
	return { baseUrl, apiKey: apiKey || undefined };
}

export class HiaiDocsError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body: unknown,
		readonly code = `http_${status}`,
	) {
		super(message);
		this.name = "HiaiDocsError";
	}
}

export interface HiaiDocsClient {
	search(params: { query: string; folder?: string; tags?: string[]; limit?: number }): Promise<unknown>;
	getDocument(id: string): Promise<unknown>;
	createDocument(input: { title: string; content?: string; folderId?: string | null; categoryId?: string | null }): Promise<unknown>;
	updateDocument(id: string, input: { title?: string; content?: string; folderId?: string | null; categoryId?: string | null }): Promise<unknown>;
	listDocuments(params: { folderId?: string; tag?: string; page?: number; limit?: number }): Promise<unknown>;
	listFolders(params: { parentId?: string }): Promise<unknown>;
	createFolder(input: { name: string; parentId?: string; categoryId?: string }): Promise<unknown>;
	listCategories(): Promise<unknown>;
	createCategory(input: { name: string; description?: string }): Promise<unknown>;
	listTags(): Promise<unknown>;
	getRelatedDocuments(documentId: string, limit?: number): Promise<unknown>;
	searchGraph(input: { query: string; docIds: string[]; limit?: number }): Promise<unknown>;
	getDocumentIndexStatus(documentId: string): Promise<unknown>;
	refreshDocumentIndex(documentId: string): Promise<unknown>;
	createSnapshot(documentId: string, input: { label: string; description?: string }): Promise<unknown>;
	getVersionHistory(documentId: string, onlySnapshots?: boolean): Promise<unknown>;
	exportDocument(id: string): Promise<ExportResponse>;
}

/** Remove caller-controlled credentials before sharing assertion scope. */
export function sanitizeMcpRequestContext(
	context?: DocsRequestContext,
): DocsRequestContext | undefined {
	if (!context) return undefined;
	const headers = new Headers(context.headers);
	if (context.workspaceAssertion) {
		headers.delete("Authorization");
		headers.delete("Cookie");
	}
	return {
		...context,
		authorization: context.workspaceAssertion ? undefined : context.authorization,
		cookie: context.workspaceAssertion ? undefined : context.cookie,
		headers,
	};
}

/** Bind a single public client and request context to every MCP capability. */
export function createMcpDocsClient(
	docsClient: DocsClient,
	requestContext?: DocsRequestContext,
): HiaiDocsClient {
	const context = sanitizeMcpRequestContext(requestContext);
	return {
		search: (params) =>
			docsClient.search(params.query, {
				folder: params.folder,
				tags: params.tags?.join(","),
				limit: params.limit,
			}, context),
		getDocument: (id) => docsClient.getDoc(id, context),
		createDocument: (input) =>
			docsClient.createDoc(
				{
					...input,
					folderId: input.folderId ?? undefined,
					categoryId: input.categoryId ?? undefined,
				},
				context,
			),
		updateDocument: (id, input) => docsClient.updateDoc(id, input, context),
		listDocuments: (params) => docsClient.listDocs(params, context),
		listFolders: (params) => docsClient.listFolders(params.parentId, context),
		createFolder: (input) => docsClient.createFolder(input, context),
		listCategories: () => docsClient.listCategories(context),
		createCategory: (input) => docsClient.createCategory(input, context),
		listTags: () => docsClient.listTags(context),
		getRelatedDocuments: (documentId, limit) =>
			docsClient.getRelatedDocuments(documentId, context, { limit }),
		searchGraph: (input) =>
			docsClient.searchGraph(
				{ query: input.query, docIds: input.docIds, maxResults: input.limit },
				context,
			),
		getDocumentIndexStatus: (documentId) =>
			docsClient.getDocumentIndexStatus(documentId, context),
		refreshDocumentIndex: (documentId) =>
			docsClient.refreshDocumentIndex(documentId, context),
		createSnapshot: (documentId, input) =>
			docsClient.createSnapshot(documentId, input, context),
		getVersionHistory: (documentId, onlySnapshots) =>
			docsClient.listVersions(documentId, { onlySnapshots }, context),
		exportDocument: async (id) => ({ markdown: await docsClient.exportDoc(id, context) }),
	};
}

export function createDefaultDocsClient(): DocsClient {
	const { baseUrl, apiKey } = readConfig();
	return new DocsClient({ baseUrl, apiKey, retries: 1 });
}

/** @deprecated Use createDocsmintMcpServer({ docsClient, requestContext }). */
export const client = new Proxy({} as HiaiDocsClient, {
	get(_target, property) {
		const configured = createMcpDocsClient(createDefaultDocsClient());
		const value = configured[property as keyof HiaiDocsClient];
		return typeof value === "function" ? value.bind(configured) : value;
	},
});
