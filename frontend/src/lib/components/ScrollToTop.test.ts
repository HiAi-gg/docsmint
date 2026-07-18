import { describe, expect, test } from "bun:test";

const source = await Bun.file(`${import.meta.dir}/ScrollToTop.svelte`).text();

describe("scroll-to-top editor docking", () => {
	test("uses measured geometry for floating FAB and toolbar modes", () => {
		expect(source).toContain('".toolbar.floating-bar"');
		expect(source).toContain('".floating-fab"');
		expect(source).toContain("style:bottom={editorDockBottom}");
	});
});
