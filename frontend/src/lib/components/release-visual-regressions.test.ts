import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) =>
	readFileSync(new URL(path, import.meta.url), "utf8");

describe("0.3.5 visual regression contracts", () => {
	test("uses Inter as the product UI typeface like docsmint.com", () => {
		const appCss = read("../../app.css");
		expect(appCss).toContain('@import "@fontsource-variable/inter/wght.css"');
		expect(appCss).toContain('"Inter Variable"');
		expect(appCss).toContain("--font-sans");
	});

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
		const layerContract = read("../styles/layer-contract.css");
		const editorPage = read("../../routes/(app)/docs/[id]/+page.svelte");
		const toolbar = read("./editor/EditorToolbar.svelte");
		const datePicker = read("./DatePicker.svelte");
		const shareDialog = read("./ShareDialog.svelte");

		expect(layerContract).toContain("--layer-chrome: 30");
		expect(layerContract).toContain("--layer-popover: 200");
		expect(layerContract).toContain("--layer-modal: 1000");
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
		expect(shareDialog).toContain("<SelectTrigger");
		expect(shareDialog).toContain("<SelectContent>");
		expect(shareDialog).not.toContain("<select bind:value={guestRole}");
	});

	test("groups GraphRAG and profile extension controls under one Advanced disclosure", () => {
		const settings = read("./SettingsDialog.svelte");
		const advancedStart = settings.indexOf(
			'<details class="profile-advanced border-t pt-4">',
		);
		const advancedEnd = settings.indexOf("</details>", advancedStart);
		const advanced = settings.slice(advancedStart, advancedEnd);

		expect(advancedStart).toBeGreaterThan(-1);
		expect(advanced).toContain("Advanced");
		expect(advanced).toContain("GraphRAG search");
		expect(advanced).toContain("{#each profileActions as action");
		expect(settings.match(/GraphRAG search/g)).toHaveLength(2);
	});

	test("packs whichever dashboard hint cards are visible into the same two-column row", () => {
		const dashboardHost = read("../hosts/HiaiDocsDashboardHost.svelte");

		expect(dashboardHost).toContain("grid grid-cols-1 gap-4 md:grid-cols-2");
		expect(dashboardHost).toContain("widget.chrome === false");
		expect(dashboardHost).toContain('? "contents"');
	});
});
