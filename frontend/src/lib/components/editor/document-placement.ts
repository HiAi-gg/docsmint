import type { Folder } from "$lib/types.js";

export interface DocumentPlacement {
	folderId: string | null;
	categoryId: string | null;
}

export function placementForFolder(
	folderId: string | null,
	folders: Folder[],
	currentCategoryId: string | null,
): DocumentPlacement {
	const targetFolder = folderId
		? folders.find((folder) => folder.id === folderId)
		: null;

	return {
		folderId,
		categoryId: targetFolder
			? (targetFolder.categoryId ?? null)
			: currentCategoryId,
	};
}

export function newFolderPlacement(
	name: string,
	categoryId: string | null,
): { name: string; parentId: null; categoryId: string | null } {
	return {
		name: name.trim(),
		parentId: null,
		categoryId,
	};
}
