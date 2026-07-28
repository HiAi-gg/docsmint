export interface SearchFolderOption {
	id: string;
	name: string;
	parentId: string | null;
	categoryId?: string | null;
}

function effectiveCategoryId(
	folder: SearchFolderOption,
	byId: ReadonlyMap<string, SearchFolderOption>,
): string | null {
	const seen = new Set<string>();
	let current: SearchFolderOption | undefined = folder;
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		if (current.categoryId) return current.categoryId;
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return null;
}

/** Folder names visible under the currently selected search category. */
export function folderNamesForSearchCategory(
	fallbackNames: readonly string[],
	folders: readonly SearchFolderOption[],
	categoryId: string,
): string[] {
	if (!categoryId) return [...fallbackNames];
	const byId = new Map(folders.map((folder) => [folder.id, folder]));
	return [
		...new Set(
			folders
				.filter((folder) => effectiveCategoryId(folder, byId) === categoryId)
				.map((folder) => folder.name),
		),
	];
}
