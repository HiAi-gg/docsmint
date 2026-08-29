import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) =>
	readFileSync(new URL(path, import.meta.url), "utf8");

describe("OSS share display adapter", () => {
	test("defaults to a public-link contour unless the host opts in", () => {
		const context = read("./share-context.ts");
		const shell = read("./DocsmintAppShellHost.svelte");
		expect(context).toContain('displayMode: "standalone"');
		expect(context).toContain("getContext<DocsmintShareAdapter>");
		expect(shell).toContain("share?: DocsmintShareAdapter");
		expect(shell).toContain('share?.displayMode ?? "standalone"');
		expect(shell).toContain("get displayMode()");
		expect(shell).toContain("provideDocsmintShareAdapter");
	});

	test("published ShareDialog default remains host-managed", () => {
		const dialog = read("../components/ShareDialog.svelte");
		expect(dialog).toContain('displayMode = "host-managed"');
	});

	test("dashboard, sidebar, and editor read the adapter instead of hardcoding", () => {
		const dashboard = read("./HiaiDocsDashboardHost.svelte");
		const tree = read("../components/sidebar/FolderTree.svelte");
		const recent = read("../components/sidebar/RecentDocs.svelte");
		const editor = read("../../routes/(app)/docs/[id]/+page.svelte");
		for (const source of [dashboard, tree, recent, editor]) {
			expect(source).toContain("getDocsmintShareAdapter");
			expect(source).toContain("displayMode={share.displayMode}");
			expect(source).not.toContain('displayMode="standalone"');
			expect(source).not.toContain('displayMode="host-managed"');
		}
	});
});
