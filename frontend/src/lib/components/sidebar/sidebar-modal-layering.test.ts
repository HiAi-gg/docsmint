import { describe, expect, test } from "bun:test";

const sidebar = await Bun.file(`${import.meta.dir}/Sidebar.svelte`).text();

describe("Sidebar modal layering", () => {
	test("keeps edge controls below the shared dialog overlay", () => {
		expect(sidebar).toContain("absolute -right-3 top-4 z-40 flex size-6");
		expect(sidebar).toContain("absolute right-0 top-0 z-40 h-full");
		expect(sidebar).not.toContain("-right-3 top-4 z-50");
	});
});
