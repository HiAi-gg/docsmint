import type {
	CreateFolderData,
	Document,
	Folder,
	UpdateFolderData,
} from "$lib/types.js";
import { apiFetch } from "./client";

interface FolderWire {
	id: string;
	name: string;
	parentId: string | null;
	ownerId?: string;
	createdAt: string;
	updatedAt: string;
}

interface DocumentWire {
	id: string;
	title: string;
	content?: string;
	contentJson?: unknown;
	metadata?: unknown;
	folderId: string | null;
	createdAt: string;
	updatedAt: string;
}

function toFolder(f: FolderWire): Folder {
	return {
		id: f.id,
		name: f.name,
		parentId: f.parentId,
		documentCount: 0,
		children: [],
		documents: [],
		createdAt: f.createdAt,
		updatedAt: f.updatedAt,
	};
}

function toDocument(d: DocumentWire, folderName = ""): Document {
	const content = d.content ?? "";
	return {
		id: d.id,
		title: d.title,
		content,
		folderId: d.folderId,
		folderName,
		tags: [],
		createdAt: d.createdAt,
		updatedAt: d.updatedAt,
		excerpt: content.length > 200 ? `${content.slice(0, 200)}…` : content,
	};
}

/** Get a single folder by ID. Backend: `GET /api/folders/:id`. */
export async function getFolder(id: string): Promise<Folder> {
	const row: FolderWire = await apiFetch<FolderWire>(
		`/api/folders/${encodeURIComponent(id)}`,
	);
	return toFolder(row);
}

/**
 * List folders under a given parent.
 *
 * - `listFolders(null)` returns a single-element array whose first element is a
 *   synthetic root folder whose `children` are the user's top-level folders.
 *   This matches the contract that `FolderTree.svelte` depends on
 *   (`result[0].children`).
 * - `listFolders(parentId)` returns the flat immediate children of `parentId`.
 *
 * The backend returns flat rows keyed by `parentId`; the tree shape is
 * composed client-side.
 */
export async function listFolders(
	parentId: string | null = null,
): Promise<Folder[]> {
	const qs = parentId ? `?parentId=${encodeURIComponent(parentId)}` : "";
	const rows: FolderWire[] = await apiFetch<FolderWire[]>(`/api/folders${qs}`);
	const folders = rows.map(toFolder);

	if (parentId === null) {
		const now = new Date().toISOString();
		return [
			{
				id: "root",
				name: "Workspace",
				parentId: null,
				documentCount: 0,
				children: folders,
				documents: [],
				createdAt: now,
				updatedAt: now,
			},
		];
	}

	return folders;
}

/**
 * Get the breadcrumb path from the workspace root down to the given folder.
 *
 * Walks up the parent chain via repeated `GET /api/folders/:id` calls and
 * reverses the collected ancestors so the returned array is ordered
 * root-first. Includes a cycle guard so a malformed parent chain cannot loop
 * forever.
 */
export async function getFolderPath(
	folderId: string,
): Promise<Array<{ id: string; name: string }>> {
	const path: Array<{ id: string; name: string }> = [];
	const visited = new Set<string>();
	let currentId: string | null = folderId;

	while (currentId && !visited.has(currentId)) {
		visited.add(currentId);
		const folder: FolderWire = await apiFetch<FolderWire>(
			`/api/folders/${encodeURIComponent(currentId)}`,
		);
		path.unshift({ id: folder.id, name: folder.name });
		currentId = folder.parentId;
	}

	return path;
}

/** Create a new folder. Backend: `POST /api/folders`. */
export async function createFolder(data: CreateFolderData): Promise<Folder> {
	const created: FolderWire = await apiFetch<FolderWire>("/api/folders", {
		method: "POST",
		body: JSON.stringify(data),
	});
	return toFolder(created);
}

/** Update a folder (rename or move). Backend: `PATCH /api/folders/:id`. */
export async function updateFolder(
	id: string,
	data: UpdateFolderData,
): Promise<Folder> {
	const updated: FolderWire = await apiFetch<FolderWire>(
		`/api/folders/${encodeURIComponent(id)}`,
		{
			method: "PATCH",
			body: JSON.stringify(data),
		},
	);
	return toFolder(updated);
}

/** Delete a folder. Backend: `DELETE /api/folders/:id`. */
export async function deleteFolder(id: string): Promise<void> {
	await apiFetch(`/api/folders/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
}

/**
 * Duplicate a document. The new copy is suffixed with ` (Copy)` on the title.
 * Backend: `POST /api/documents/:id/duplicate`.
 */
export async function duplicateDocument(docId: string): Promise<Document> {
	const created: DocumentWire = await apiFetch<DocumentWire>(
		`/api/documents/${encodeURIComponent(docId)}/duplicate`,
		{
			method: "POST",
		},
	);
	return toDocument(created);
}

/** Delete a document. Backend: `DELETE /api/documents/:id`. */
export async function deleteDocument(docId: string): Promise<void> {
	await apiFetch(`/api/documents/${encodeURIComponent(docId)}`, {
		method: "DELETE",
	});
}
