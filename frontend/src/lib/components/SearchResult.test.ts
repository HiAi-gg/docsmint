import { describe, expect, test } from "bun:test";

const source = await Bun.file(`${import.meta.dir}/SearchResult.svelte`).text();

describe("SearchResult explanation badges", () => {
	test("renders a bounded, safe explanation list", () => {
		expect(source).toContain("explanations.slice(0, 3)");
		expect(source).toContain('aria-label="Search match explanations"');
		expect(source).not.toContain("queryVariant}");
		expect(source).not.toContain("tenant");
	});
});
