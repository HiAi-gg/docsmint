import { describe, expect, test } from "bun:test";

const treeSource = await Bun.file(
	`${import.meta.dir}/FolderTree.svelte`,
).text();
const nodeSource = await Bun.file(
	`${import.meta.dir}/FolderNode.svelte`,
).text();

describe("nested folder workflows", () => {
	test("category and folder menus open the shared folder dialog with scope", () => {
		expect(treeSource).toContain("openNewFolderInCategory(bucket.category.id)");
		expect(treeSource).toContain("onCreateSubfolder={openNewSubfolder}");
		expect(nodeSource).toContain("onCreateSubfolder(folder.id)");
		expect(treeSource).toContain("const parentId = newFolderParentId");
		expect(treeSource).toContain("const createdFolder = await createFolder({");
		expect(treeSource).toContain("parentId,");
		expect(treeSource).toContain("categoryId: newFolderCategoryId");
	});

	test("new subfolders expand and refresh their parent immediately", () => {
		expect(treeSource).toContain(
			"expandedFolderIds = new Set(expandedFolderIds).add(parentId)",
		);
		expect(treeSource).toContain("bumpSubfoldersRefresh(parentId)");
		expect(nodeSource).toContain(
			"if (!subfoldersLoaded && !isExpanded) return",
		);
	});

	test("folder cycle guard walks from destination toward its ancestors", () => {
		expect(treeSource).toContain("getFolderFromRegistry(currentId)?.parentId");
		expect(treeSource).not.toContain("pid && blocked.has(pid)");
	});
});
