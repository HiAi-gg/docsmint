import { describe, expect, test } from "bun:test";

const source = await Bun.file(
	`${import.meta.dir}/MobileSidebarToggle.svelte`,
).text();

describe("mobile sidebar toggle modal layering", () => {
	test("removes persistent navigation chrome while a modal dialog is open", () => {
		expect(source).toContain('[role="dialog"][aria-modal="true"]');
		expect(source).toContain("{#if !modalOpen}");
	});

	test("marks nested mobile dialogs so fixed overlays escape the translated sidebar", async () => {
		expect(source).toContain("nested-sidebar-modal-open");
		expect(source).toContain('dialog.tagName !== "ASIDE"');
		const appCss = await Bun.file(`${import.meta.dir}/../../app.css`).text();
		expect(appCss).toContain("html.nested-sidebar-modal-open");
		expect(appCss).toContain("translate: none !important");
	});
});
