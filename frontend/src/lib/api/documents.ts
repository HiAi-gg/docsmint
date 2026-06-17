import { apiFetch } from "./client";

export interface Document {
	id: string;
	title: string;
	content: string;
	contentTipex?: unknown;
	folderId?: string | null;
	folderName?: string;
	tags?: Array<{ id: string; name: string; color: string }>;
	excerpt?: string;
	createdAt: string;
	updatedAt: string;
}

export interface DocumentListResponse {
	items: Document[];
	total: number;
	page: number;
	limit: number;
}

export function listDocuments(params?: {
	folderId?: string;
	tag?: string;
	page?: number;
	limit?: number;
}): Promise<DocumentListResponse> {
	const searchParams = new URLSearchParams();
	if (params?.folderId) searchParams.set("folderId", params.folderId);
	if (params?.tag) searchParams.set("tag", params.tag);
	if (params?.page) searchParams.set("page", String(params.page));
	if (params?.limit) searchParams.set("limit", String(params.limit));
	const qs = searchParams.toString();
	return apiFetch(`/api/documents${qs ? `?${qs}` : ""}`);
}

export function getDocument(
	id: string,
	fetcher?: typeof fetch,
): Promise<Document> {
	return apiFetch(`/api/documents/${id}`, {}, fetcher);
}

export function createDocument(data: {
	title: string;
	content?: string;
	folderId?: string;
}): Promise<Document> {
	return apiFetch("/api/documents", {
		method: "POST",
		body: JSON.stringify(data),
	});
}

export function updateDocument(
	id: string,
	data: {
		title?: string;
		content?: string;
		folderId?: string | null;
		contentTipex?: unknown;
	},
): Promise<Document> {
	return apiFetch(`/api/documents/${id}`, {
		method: "PATCH",
		body: JSON.stringify(data),
	});
}

export function deleteDocument(id: string): Promise<void> {
	return apiFetch(`/api/documents/${id}`, { method: "DELETE" });
}

export function importDocument(
	file: File,
	folderId?: string,
): Promise<Document> {
	const formData = new FormData();
	formData.append("file", file);
	if (folderId) formData.append("folderId", folderId);
	return apiFetch("/api/documents/import", { method: "POST", body: formData });
}
