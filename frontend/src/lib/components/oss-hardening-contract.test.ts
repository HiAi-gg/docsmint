import { describe, expect, test } from "bun:test";

const read = (path: string) => Bun.file(`${import.meta.dir}/${path}`).text();

describe("standalone OSS hardening contracts", () => {
	test("keeps host-managed sharing as the default while standalone callers hide people-only sharing", async () => {
		const [dialog, sidebar, editor, dashboard] = await Promise.all([
			read("ShareDialog.svelte"),
			read("sidebar/FolderTree.svelte"),
			read("../../routes/(app)/docs/[id]/+page.svelte"),
			read("../hosts/HiaiDocsDashboardHost.svelte"),
		]);

		expect(dialog).toContain('displayMode = "host-managed"');
		expect(dialog).toContain('displayMode !== "standalone"');
		expect(sidebar).toContain('displayMode="standalone"');
		expect(editor).toContain('displayMode="standalone"');
		expect(dashboard).not.toContain('displayMode="standalone"');
	});

	test("uses one parent-driven printable export path without marked or injected print scripts", async () => {
		const [editor, shared] = await Promise.all([
			read("../../routes/(app)/docs/[id]/+page.svelte"),
			read("../../routes/s/[token]/+page.svelte"),
		]);

		for (const source of [editor, shared]) {
			expect(source).toContain("createPrintableDocumentHtml");
			expect(source).not.toContain("marked.parse");
			expect(source).not.toContain("window.onload = function");
			expect(source).toContain("iframe.contentWindow?.print()");
		}
	});

	test("keeps credentials out of browser settings and recovers accessible auth and card interactions", async () => {
		const [settings, settingsApi, register, login, documentCard, folderCard] =
			await Promise.all([
				read("../../routes/(app)/settings/+page.svelte"),
				read("../api/settings.ts"),
				read("../../routes/register/+page.svelte"),
				read("../../routes/login/+page.svelte"),
				read("DocumentCard.svelte"),
				read("FolderCard.svelte"),
			]);

		expect(settings).not.toContain("embedding-api-key");
		expect(settings).toContain("docs/DEPLOYMENT.md");
		expect(settingsApi).not.toContain("EMBEDDING_KEY");
		expect(settingsApi).not.toContain("localStorage");
		expect(register).toContain("} finally {");
		expect(register).toContain("loading = false");
		expect(register).toContain('role="alert"');
		expect(login).toContain('role="alert"');
		expect(documentCard).toContain(
			"onkeydown={(e: KeyboardEvent) => e.stopPropagation()}",
		);
		expect(folderCard).toContain(
			"onkeydown={(e: KeyboardEvent) => e.stopPropagation()}",
		);
	});
});
