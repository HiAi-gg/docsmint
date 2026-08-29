import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (relative: string) =>
	readFileSync(resolve(import.meta.dir, relative), "utf8");

describe("search responsive containment", () => {
	test("embedded host menus use portals and cannot stretch their filter rows", () => {
		const dashboard = read("../hosts/HiaiDocsDashboardHost.svelte");
		const search = read("../hosts/HiaiDocsSearchHost.svelte");
		expect(dashboard).toContain("<SelectPrimitive.Portal>");
		expect(dashboard).toContain("<DropdownMenuPrimitive.Portal>");
		expect(search).toContain("<SelectPrimitive.Portal>");
	});

	test("search results wrap unbroken content inside the result card", () => {
		const source = read("SearchResult.svelte");
		expect(source).toContain("[overflow-wrap:anywhere]");
		expect(source).toContain("min-w-0 overflow-hidden");
	});

	test("mobile search field reserves space for the sidebar toggle", () => {
		const source = read("../hosts/HiaiDocsSearchHost.svelte");
		expect(source).toContain('class="search-form relative mb-6"');
		expect(source).toContain("margin-left: 56px");
	});

	test("mobile dashboard identity reserves space for the sidebar toggle", () => {
		const source = read("../hosts/HiaiDocsDashboardHost.svelte");
		expect(source).toContain(".dashboard-context-identity");
		expect(source).toContain("margin-left: 56px");
		expect(source).toContain(".dashboard-context-identity h1");
	});
});

describe("public share branding and actions", () => {
	test("uses DocsMint branding and groups mobile exports in a menu", () => {
		const source = read("../../routes/s/[token]/+page.svelte");
		expect(source).toContain('href="https://docsmint.com"');
		expect(source).toContain('src="/favicon.ico"');
		expect(source).toContain('class="sm:hidden"');
		expect(source).toContain("<DropdownMenuContent");
	});
});

describe("dashboard sharing entry points", () => {
	test("folder and document card menus can open the shared dialog", () => {
		const folderCard = read("FolderCard.svelte");
		const documentCard = read("DocumentCard.svelte");
		expect(folderCard).toContain("onShare?.(folder.id, folder.name)");
		expect(documentCard).toContain("onShare?.(doc.id, doc.title)");
		expect(folderCard).toContain("opacity-100 transition-opacity");
		expect(documentCard).toContain("opacity-100 transition-opacity");
	});

	test("recent document menus can open the shared dialog", () => {
		const source = read("sidebar/RecentDocs.svelte");
		expect(source).toContain("openShareDialogForDocument(doc.id, doc.title)");
		expect(source).toContain("displayMode={share.displayMode}");
		expect(source).toContain("documentId={shareDocumentId}");
	});

	test("dashboard category sections expose category sharing", () => {
		const source = read("../hosts/HiaiDocsDashboardHost.svelte");
		expect(source).toContain("openShareDialogForCategory");
		expect(source).toContain(
			'categoryId={shareTarget.kind === "category" ? shareTarget.categoryId : ""}',
		);
	});
});

describe("embedded taxonomy refresh bridge", () => {
	test("refreshes OSS-owned sidebar stores after host document mutations", () => {
		const source = read("sidebar/Sidebar.svelte");
		expect(source).toContain("hiai-docs:documents-updated");
		expect(source).toContain("refreshFolders()");
		expect(source).toContain("refreshDocs()");
	});
});
