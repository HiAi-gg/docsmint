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

	test("does not subscribe the placement effect to the document array it mutates", () => {
		expect(folderTree).toContain(
			'import { onDestroy, onMount, untrack } from "svelte"',
		);
		expect(folderTree).toContain("untrack(() => {");
		expect(folderTree.indexOf("untrack(() => {")).toBeLessThan(
			folderTree.indexOf("const index = documents.findIndex"),
		);
	});

	test("merges the optimistic placement into a late server response", () => {
		expect(folderTree).toContain("getPendingDocumentPlacement(doc.id)");
		expect(folderTree).toContain(
			"folderId: getPendingDocumentPlacement(doc.id)?.folderId ?? null",
		);
	});

	test("sidebar moves supersede an acknowledged editor placement", () => {
		expect(folderTree).toContain("createDocumentPlacementWriter({");
		expect(folderTree).toContain("acknowledge: acknowledgeDocumentPlacement");
	});

	test("invalidates a late refresh before rolling back a failed move", () => {
		const rollbackStart = folderTree.indexOf(
			"function rollbackDocumentPlacement",
		);
		const rollbackEnd = folderTree.indexOf("const writeDocumentPlacement");
		const rollback = folderTree.slice(rollbackStart, rollbackEnd);
		expect(rollback).toContain("documentsLoadGeneration++");
	});
});
