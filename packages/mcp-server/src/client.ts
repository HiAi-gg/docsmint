/**
 * Compatibility adapter from the public DocsClient to the MCP capability
 * surface. The MCP server has no independent REST transport.
 */

import { DocsClient, type DocsRequestContext, type DocsAttachment, type DocsAttachmentListResponse } from "@hiai-docs/sdk";

import { createHash } from "node:crypto";
import { verifyAttachmentResponse, type AttachmentVerification } from "./attachment-verification.js";

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
	uploadDocumentImage?(id: string, filename: string, mimeType: string, bytes: Buffer, operationId?: string): Promise<DocsAttachment>;
	listAttachments?(id: string): Promise<DocsAttachmentListResponse>;
	verifyAttachment?(attachment: DocsAttachment): Promise<AttachmentVerification>;
	getFolder?(id: string): Promise<unknown>;
	createTag?(input: { name: string; color?: string }): Promise<unknown>;
	updateTag?(id: string, input: { name?: string; color?: string }): Promise<unknown>;
	deleteTag?(id: string): Promise<void>;
	addTagToDocument?(documentId: string, tagId: string): Promise<void>;
	removeTagFromDocument?(documentId: string, tagId: string): Promise<void>;
	updateFolder?(id: string, input: { name?: string; parentId?: string | null; categoryId?: string | null; order?: number }): Promise<unknown>;
	updateCategory?(id: string, input: { name?: string; order?: number }): Promise<unknown>;
	listTrash?(): Promise<unknown>;
	restoreTrashedDocument?(id: string): Promise<unknown>;
	permanentlyDeleteDocument?(id: string): Promise<unknown>;
	deleteDocument?(id: string): Promise<void>;
	deleteFolder?(id: string): Promise<void>;
	deleteCategory?(id: string): Promise<void>;
	restoreDocumentVersion?(documentId: string, versionId: string): Promise<unknown>;
	search(params: { query: string; folder?: string; tags?: string[]; limit?: number; includeChunks?: boolean; includeDiagnostics?: boolean }): Promise<unknown>;
	getDocument(id: string): Promise<unknown>;
	createDocument(input: { title?: string; content?: string; folderId?: string | null; categoryId?: string | null }): Promise<unknown>;
	updateDocument(id: string, input: { title?: string; content?: string; folderId?: string | null; categoryId?: string | null }): Promise<unknown>;
	listDocuments(params: import("@hiai-docs/sdk").DocsListOptions): Promise<unknown>;
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
	docsClient: Omit<DocsClient, "withRequestContext">,
	requestContext?: DocsRequestContext,
): HiaiDocsClient {
	const context = sanitizeMcpRequestContext(requestContext);
	return {
		uploadDocumentImage: async (id, filename, mimeType, bytes, operationId) => {
			const descriptor = {
				filename,
				contentType: mimeType,
				size: bytes.byteLength,
				...(operationId
					? { sourceSha256: createHash("sha256").update(bytes).digest("hex") }
					: {}),
			};
			const uploadContext = operationId
				? { ...context, headers: new Headers(context?.headers) }
				: context;
			if (operationId && uploadContext?.headers instanceof Headers)
				uploadContext.headers.set("Idempotency-Key", operationId);
			const upload = await docsClient.presignAttachment(
				id,
				descriptor,
				uploadContext,
			);
			if (!upload.alreadyConfirmed) {
				const response = await fetch(upload.url, {
					method: "PUT",
					body: new Blob([Uint8Array.from(bytes)], { type: mimeType }),
					redirect: "error",
					signal: context?.signal,
				}).catch(() => {
					throw new Error("Could not send image bytes to DocsMint storage.");
				});
				await response.body?.cancel();
				if (!response.ok)
					throw new Error(
						`DocsMint storage rejected the image (${response.status}).`,
					);
			}
			return docsClient.confirmAttachment(
				id,
				{
					...descriptor,
					key: upload.key,
					uploadToken: upload.uploadToken,
					quotaReservationId: upload.quotaReservationId,
				},
				context,
			);
		},
		listAttachments: (id) => docsClient.listAttachments(id, context),
		verifyAttachment: async (attachment) => {
			const signal = context?.signal
				? AbortSignal.any([context.signal, AbortSignal.timeout(30_000)])
				: AbortSignal.timeout(30_000);
			const response = await docsClient.fetchAttachment(attachment.id, {
				...context,
				signal,
			});
			return verifyAttachmentResponse(response, attachment);
		},
		getFolder: (id) => docsClient.getFolder(id, context),
		createTag: (input) => docsClient.createTag(input, context),
		updateTag: (id, input) => docsClient.updateTag(id, input, context),
		deleteTag: (id) => docsClient.deleteTag(id, context),
		addTagToDocument: (documentId, tagId) => docsClient.addTagToDoc(documentId, tagId, context),
		removeTagFromDocument: (documentId, tagId) => docsClient.removeTagFromDoc(documentId, tagId, context),
		updateFolder: (id, input) => docsClient.updateFolder(id, input, context),
		updateCategory: (id, input) => docsClient.updateCategory(id, input, context),
		listTrash: () => docsClient.listTrash(context),
		restoreTrashedDocument: (id) => docsClient.restoreTrashedDocument(id, context),
		permanentlyDeleteDocument: (id) => docsClient.permanentlyDeleteDocument(id, context),
		deleteDocument: (id) => docsClient.deleteDoc(id, context),
		deleteFolder: (id) => docsClient.deleteFolder(id, context),
		deleteCategory: (id) => docsClient.deleteCategory(id, context),
		restoreDocumentVersion: (documentId, versionId) => docsClient.restoreVersion(documentId, versionId, context),
		search: (params) =>
			docsClient.search(params.query, {
				folder: params.folder,
				tags: params.tags?.join(","),
				limit: params.limit,
                includeChunks: params.includeChunks,
                includeDiagnostics: params.includeDiagnostics,
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
		exportDocument: (id) => docsClient.exportDocWithMetadata(id, context),
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
