import { describe, expect, test } from "bun:test";

const folderTree = await Bun.file(
	`${import.meta.dir}/FolderTree.svelte`,
).text();

describe("FolderTree placement refresh", () => {
	test("ignores superseded document-list responses", () => {
		expect(folderTree).toContain(
			"const generation = ++documentsLoadGeneration",
		);
		expect(folderTree).toContain(
			"if (generation !== documentsLoadGeneration) return",
		);
	});

	test("applies the newest editor placement before a server refresh completes", () => {
		expect(folderTree).toContain("getDocumentPlacementNonce()");
		expect(folderTree).toContain("getLatestDocumentPlacement()");
		expect(folderTree).toContain("documentsLoadGeneration++");
		expect(folderTree).toContain("folderId: placement.folderId");
		expect(folderTree).toContain("categoryId: placement.categoryId");
		expect(folderTree).toContain("resyncZonesFromDocuments()");
	});

	test("merges the optimistic placement into a late server response", () => {
		expect(folderTree).toContain("latestPlacement?.id === doc.id");
		expect(folderTree).toContain("folderId: latestPlacement.folderId");
		expect(folderTree).toContain("categoryId: latestPlacement.categoryId");
	});
});
