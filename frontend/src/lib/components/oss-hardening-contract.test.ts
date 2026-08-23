import { describe, expect, test } from "bun:test";

const read = (path: string) => Bun.file(`${import.meta.dir}/${path}`).text();

describe("standalone OSS hardening contracts", () => {
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

	test("keeps credentials out of browser settings", async () => {
		const [settings, settingsApi] = await Promise.all([
			read("../../routes/(app)/settings/+page.svelte"),
			read("../api/settings.ts"),
		]);

		expect(settings).not.toContain("embedding-api-key");
		expect(settings).toContain("docs/DEPLOYMENT.md");
		expect(settingsApi).not.toContain("EMBEDDING_KEY");
		expect(settingsApi).not.toContain("localStorage");
	});
});
