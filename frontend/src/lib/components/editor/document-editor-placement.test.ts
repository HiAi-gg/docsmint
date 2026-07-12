import { describe, expect, test } from "bun:test";

const editorPage = await Bun.file(
	`${import.meta.dir}/../../../routes/(app)/docs/[id]/+page.svelte`,
).text();

describe("document editor placement workflow", () => {
	test("persists category and folder selections independently of content autosave", () => {
		expect(editorPage).toContain("createPlacementMutationQueue");
		expect(editorPage).toContain("await enqueuePlacementMutation(placement)");
		expect(editorPage).toContain(
			"await enqueuePlacementMutation({ categoryId, folderId: null })",
		);
		expect(editorPage).toContain('saveStatus = "saving"');
		expect(editorPage).toContain("publishDocumentPlacement");
		expect(editorPage).toContain("refreshDocs()");
	});

	test("closes the editor folder dialog after create-and-place succeeds", () => {
		const createFolderHandler = editorPage.slice(
			editorPage.indexOf("async function handleCreateFolder"),
			editorPage.indexOf("// --- Keyboard shortcuts"),
		);

		expect(createFolderHandler).toContain("await moveToFolder(folderId, true)");
		expect(editorPage).toContain("bind:open={showCreateFolderDialog}");
		expect(editorPage).not.toContain("closeOnSave={false}");
	});
});
