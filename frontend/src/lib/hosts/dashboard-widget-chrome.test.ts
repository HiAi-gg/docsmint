import { describe, expect, test } from "bun:test";

const hostSource = await Bun.file(
	new URL("./HiaiDocsDashboardHost.svelte", import.meta.url),
).text();
const typeSource = await Bun.file(
	new URL("../extensions/types.ts", import.meta.url),
).text();

describe("dashboard widget chrome contract", () => {
	test("lets transient extensions opt out of the host card", () => {
		expect(typeSource).toContain("chrome?: boolean");
		expect(hostSource).toContain("widget.chrome === false");
		expect(hostSource).toContain('? "contents"');
	});

	test("honors full-width dashboard widgets", () => {
		expect(hostSource).toContain("widget.colSpan === 12");
		expect(hostSource).toContain("md:col-span-2");
	});
});
