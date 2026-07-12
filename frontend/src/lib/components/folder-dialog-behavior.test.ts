import { describe, expect, test } from "bun:test";

const dialogSource = await Bun.file(
	`${import.meta.dir}/FolderDialog.svelte`,
).text();
const sidebarSource = await Bun.file(
	`${import.meta.dir}/sidebar/FolderTree.svelte`,
).text();

describe("FolderDialog completion behavior", () => {
	test("closes after a successful save by default, including while submitting", () => {
		expect(dialogSource).toContain("closeOnSave = true");
		expect(dialogSource).toContain("if (closeOnSave)");
		expect(dialogSource).toContain("close(true)");
		expect(dialogSource).toContain("if (busy && !force) return");
	});

	test("sidebar shows success feedback and preserves multi-create", () => {
		expect(sidebarSource).toContain("closeOnSave={false}");
		expect(dialogSource).toContain("Folder created");
		expect(dialogSource).toContain('typeof savedFolder.name === "string"');
		expect(sidebarSource).toContain("return createdFolder");
		expect(dialogSource).toContain("Create another");
		expect(dialogSource).toContain("function createAnother()");
		expect(dialogSource).toContain('name = ""');
	});
});
