import { describe, expect, test } from "bun:test";

const editorPage = await Bun.file(
	`${import.meta.dir}/../../../routes/(app)/docs/[id]/+page.svelte`,
).text();

describe("document editor placement workflow", () => {
	test("persists category and folder selections independently of content autosave", () => {
		expect(editorPage).toContain(
			"await updateDocument(data.document.id, placement)",
		);
		expect(editorPage).toContain(
			"await updateDocument(data.document.id, { categoryId, folderId: null })",
		);
		expect(editorPage).toContain('saveStatus = "saving"');
		expect(editorPage).toContain("refreshDocs()");
	});

	test("closes the editor folder dialog after create-and-place succeeds", () => {
		const createFolderHandler = editorPage.slice(
			editorPage.indexOf("async function handleCreateFolder"),
			editorPage.indexOf("// --- Keyboard shortcuts"),
		);

		expect(createFolderHandler).toContain("await moveToFolder(folderId, true)");
		expect(createFolderHandler).toContain("showCreateFolderDialog = false");
	});
});
