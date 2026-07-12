import { describe, expect, test } from "bun:test";
import type { Folder } from "$lib/types.js";
import { newFolderPlacement, placementForFolder } from "./document-placement";

function folder(id: string, categoryId: string | null): Folder {
	return {
		id,
		name: id,
		parentId: null,
		categoryId,
		order: 0,
		documentCount: 0,
		subfolderCount: 0,
		children: [],
		documents: [],
		createdAt: "2026-07-12T00:00:00.000Z",
		updatedAt: "2026-07-12T00:00:00.000Z",
	};
}

describe("document placement", () => {
	test("uses the selected folder category when moving a document", () => {
		expect(
			placementForFolder("folder-a", [folder("folder-a", "category-a")], null),
		).toEqual({
			folderId: "folder-a",
			categoryId: "category-a",
		});
	});

	test("keeps the selected category when clearing a folder", () => {
		expect(placementForFolder(null, [], "category-a")).toEqual({
			folderId: null,
			categoryId: "category-a",
		});
	});

	test("clears the category when moving into an uncategorized folder", () => {
		expect(
			placementForFolder("folder-a", [folder("folder-a", null)], "category-a"),
		).toEqual({
			folderId: "folder-a",
			categoryId: null,
		});
	});

	test("creates an editor folder in the document's selected category", () => {
		expect(newFolderPlacement("  Guides  ", "category-a")).toEqual({
			name: "Guides",
			parentId: null,
			categoryId: "category-a",
		});
	});
});
