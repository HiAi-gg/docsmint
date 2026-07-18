import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsedContentCacheKey } from "./parsed-content-cache";

describe("responsive editor and settings UI", () => {
	test("embedded toolbar follows the rounded editor container", () => {
		const source = readFileSync(
			resolve(import.meta.dir, "EditorToolbar.svelte"),
			"utf8",
		);
		expect(source).toContain("border-radius: 7px 7px 0 0");
	});

	test("login uses the canonical favicon asset", () => {
		const source = readFileSync(
			resolve(import.meta.dir, "../../../routes/login/+page.svelte"),
			"utf8",
		);
		expect(source).toContain('src="/favicon.ico"');
		expect(source).toContain('src="/favicon_white.ico"');
		expect(source).toContain('href="https://docsmint.com"');
		expect(source).not.toContain('src="/logo.png"');
	});

	test("settings tabs share the entire available width", () => {
		const source = readFileSync(
			resolve(import.meta.dir, "../SettingsDialog.svelte"),
			"utf8",
		);
		expect(source).toContain("repeat(auto-fit,minmax(0,1fr))");
	});

	test("style settings expose Markdown but no Raw JSON mode", () => {
		const source = readFileSync(
			resolve(import.meta.dir, "../SettingsDialog.svelte"),
			"utf8",
		);
		expect(source).toContain("showMarkdownMode");
		expect(source).not.toContain("showJsonMode");
		expect(source).not.toContain("Raw JSON");
		expect(source).toContain("showVisualMode");
		expect(source).toContain("minimalToolbar");
	});

	test("minimal toolbar keeps the requested compact control set", () => {
		const source = readFileSync(
			resolve(import.meta.dir, "EditorToolbar.svelte"),
			"utf8",
		);
		expect(source).toContain("{#if minimal}");
		expect(source).toContain("{@render basicFormatSnippet()}");
		expect(source).toContain("{@render listDropdown()}");
		expect(source).toContain("{@render highlightPicker()}");
		expect(source).toContain("{@render copyContentSnippet()}");
	});

	test("editor preferences are collapsed switches rather than checkboxes", () => {
		const source = readFileSync(
			resolve(import.meta.dir, "../SettingsDialog.svelte"),
			"utf8",
		);
		expect(source).toContain('<details class="editor-settings');
		expect(source).toContain('role="switch"');
		expect(source).not.toContain('type="checkbox"');
		expect(source).toContain("showScrollToTop");
	});

	test("mobile scroll-to-top control clears the floating document editor", () => {
		const source = readFileSync(
			resolve(import.meta.dir, "../ScrollToTop.svelte"),
			"utf8",
		);
		expect(source).toContain('".toolbar.floating-bar"');
		expect(source).toContain('".floating-fab"');
		expect(source).toContain("getBoundingClientRect()");
		expect(source).toContain("style:bottom={editorDockBottom}");
	});

	test("document overflow menu starts with new document in every editor mode", () => {
		const source = readFileSync(
			resolve(import.meta.dir, "../../../routes/(app)/docs/[id]/+page.svelte"),
			"utf8",
		);
		expect(source).toContain('goto("/docs/new")');
		expect(source).toContain("{m.dashboard_new_document()}");
	});

	test("floating toolbar becomes edge-to-edge and wraps on narrow screens", () => {
		const source = readFileSync(
			resolve(import.meta.dir, "EditorToolbar.svelte"),
			"utf8",
		);
		expect(source).toContain("@media (max-width: 640px)");
		expect(source).toContain(".floating-toolbar-row");
		expect(source).toContain("flex-wrap: wrap");
		expect(source).toContain(".floating-toolbar-close");
		expect(source).toContain("position: absolute");
		expect(source).toContain("display: contents");
		expect(source).toContain(".floating-toolbar-spacer");
	});

	test("large documents show an animated loading state while parsing", () => {
		const source = readFileSync(
			resolve(import.meta.dir, "HiAiEditor.svelte"),
			"utf8",
		);
		expect(source).toContain("Preparing large document…");
		expect(source).toContain("large-document-spinner");
		expect(source).toContain("aria-busy={deferredContentLoading}");
	});

	test("editor module loading has padded visual feedback", () => {
		const source = readFileSync(
			resolve(import.meta.dir, "../../../routes/(app)/docs/[id]/+page.svelte"),
			"utf8",
		);
		expect(source).toContain("Preparing editing tools");
		expect(source).toContain("padding: clamp(28px, 7vw, 72px) 20px");
	});
});

describe("parsed document cache", () => {
	test("partitions entries by document revision", () => {
		expect(parsedContentCacheKey("doc-1", "revision-a")).not.toBe(
			parsedContentCacheKey("doc-1", "revision-b"),
		);
	});
});
