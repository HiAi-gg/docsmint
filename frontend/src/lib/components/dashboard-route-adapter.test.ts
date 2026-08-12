import { describe, expect, test } from "bun:test";

const dashboardSource = await Bun.file(
	`${import.meta.dir}/../hosts/HiaiDocsDashboardHost.svelte`,
).text();
const folderTreeSource = await Bun.file(
	`${import.meta.dir}/sidebar/FolderTree.svelte`,
).text();

describe("embedded dashboard navigation", () => {
	test("routes dashboard Home links through the host route adapter", () => {
		expect(dashboardSource).toContain(
			'href={resolveDocsmintRoute(route, "/")}',
		);
		expect(folderTreeSource).toMatch(
			/href=\{resolveDocsmintRoute\(route, ["']\/["']\)\}/,
		);
		expect(dashboardSource).not.toMatch(/\bhref="\/"/);
		expect(folderTreeSource).not.toMatch(/\bhref="\/"/);
	});

	test("routes folder breadcrumbs through the host route adapter", () => {
		expect(dashboardSource).toMatch(
			/href=\{resolveDocsmintRoute\(route, `\/\?folder=\$\{encodeURIComponent\(path\.id\)\}`\)\}/,
		);
		expect(dashboardSource).not.toContain('href="/?folder=');
	});
});
