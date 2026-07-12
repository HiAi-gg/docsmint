import { describe, expect, test } from "bun:test";

const dialogSource = await Bun.file(
	`${import.meta.dir}/../DeleteDialog.svelte`,
).text();
const folderTreeSource = await Bun.file(
	`${import.meta.dir}/FolderTree.svelte`,
).text();
const categoryDialogSource = await Bun.file(
	`${import.meta.dir}/CategoryDialog.svelte`,
).text();

describe("delete confirmation UX", () => {
	test("requires an explicit confirmation and prevents duplicate submits", () => {
		expect(dialogSource).toContain("Delete <span");
		expect(dialogSource).toContain("if (busy || success) return");
		expect(dialogSource).toContain("if (!next && busy)");
		expect(dialogSource).toContain("open = true");
		expect(dialogSource).toContain('role="alert"');
	});

	test("shows the deleted target in branded success feedback", () => {
		expect(dialogSource).toContain("successTitle");
		expect(dialogSource).toContain("border-primary/30 bg-primary/10");
		expect(dialogSource).toContain('role="status"');
		expect(folderTreeSource).toContain('targetName={deleteTarget?.name ?? ""}');
		expect(folderTreeSource).toContain("m.folders_delete_success()");
	});

	test("keeps category delete errors open and confirms the named category", () => {
		expect(categoryDialogSource).toContain("deletedCategoryName");
		expect(categoryDialogSource).toContain(
			'Delete <span class="font-medium text-foreground">',
		);
		expect(categoryDialogSource).toContain("m.categories_delete_success()");
		expect(categoryDialogSource).toContain(
			"function handleDialogOpenChange(next: boolean)",
		);
		expect(categoryDialogSource).toContain("if (!next && busy)");
		expect(categoryDialogSource).toContain("open = true");
		expect(categoryDialogSource).toContain(
			"error = err instanceof Error ? err.message : m.categories_delete_error()",
		);
	});
});
