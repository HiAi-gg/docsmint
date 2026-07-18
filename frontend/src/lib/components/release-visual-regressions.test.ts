import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) =>
	readFileSync(new URL(path, import.meta.url), "utf8");

describe("0.3.4 visual regression contracts", () => {
	test("keeps the title favicon synchronized with the resolved app theme", () => {
		const appHtml = read("../../app.html");
		const themeStore = read("../stores/theme.svelte.ts");
		expect(appHtml).toContain('id="app-favicon"');
		expect(appHtml).toContain('isDark ? "/favicon_white.ico" : "/favicon.ico"');
		expect(themeStore).toContain('"#app-favicon"');
		expect(themeStore).toContain(
			'isDark ? "/favicon_white.ico" : "/favicon.ico"',
		);
	});

	test("renders the share loading state before client-side data arrives", () => {
		const load = read("../../routes/s/[token]/+page.ts");
		const page = read("../../routes/s/[token]/+page.svelte");
		expect(load).not.toContain("await fetch(");
		expect(page).toContain("let loading = $state(true)");
		expect(page).toContain("onMount(() =>");
		expect(page).toContain("share-loading-spinner");
	});

	test("refreshes Recent after a successful content save", () => {
		const editorPage = read("../../routes/(app)/docs/[id]/+page.svelte");
		const saveBlock = editorPage.slice(
			editorPage.indexOf("async function saveContent"),
			editorPage.indexOf("async function handleTitleUpdate"),
		);
		expect(saveBlock).toContain("refreshDocs();");
	});

	test("keeps Markdown sizing and disables Raw JSON", () => {
		const markdown = read("./editor/MarkdownToggle.svelte");
		const editorPage = read("../../routes/(app)/docs/[id]/+page.svelte");
		const settings = read("./SettingsDialog.svelte");
		expect(markdown).toContain("height: 100%");
		expect(markdown).toContain("min-height: 0");
		expect(markdown).toContain("textarea.scrollHeight");
		expect(markdown).toContain("rawEditor?.clientHeight");
		expect(markdown).toContain("textarea.style.minHeight");
		expect(editorPage).not.toContain("JsonToggle");
		expect(editorPage).not.toContain('mode === "json"');
		expect(settings).not.toContain("showJsonMode");
		expect(settings).not.toContain("Raw JSON");
	});

	test("keeps every popup above persistent chrome and every modal above popovers", () => {
		const appCss = read("../../app.css");
		const editorPage = read("../../routes/(app)/docs/[id]/+page.svelte");
		const toolbar = read("./editor/EditorToolbar.svelte");
		const datePicker = read("./DatePicker.svelte");
		const shareDialog = read("./ShareDialog.svelte");

		expect(appCss).toContain("--layer-chrome: 30");
		expect(appCss).toContain("--layer-popover: 200");
		expect(appCss).toContain("--layer-modal: 1000");
		expect(appCss).toContain(':has(> [role="dialog"])');
		expect(appCss).toContain(".fixed.inset-0.z-50");
		expect(editorPage).toContain("z-index: var(--layer-chrome)");
		expect(editorPage).toContain("z-index: var(--layer-popover)");
		expect(toolbar).toContain("z-index: var(--layer-chrome)");
		expect(toolbar).toContain("z-index: var(--layer-popover)");
		expect(datePicker).toContain("z-index: var(--layer-popover)");
		expect(shareDialog).toContain("fixed inset-0 layer-modal");
		expect(shareDialog).toContain('role="dialog"');
		expect(shareDialog).toContain('aria-modal="true"');
	});
});
