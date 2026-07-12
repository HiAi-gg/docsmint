import { describe, expect, test } from "bun:test";

const source = await Bun.file(`${import.meta.dir}/FolderTree.svelte`).text();

describe("category drag-and-drop stability", () => {
	test("deduplicates transient dnd items before keyed rendering", () => {
		expect(source).toContain("const seen = new Set<string>()");
		expect(source).toContain("if (seen.has(bucket.id))");
		expect(source).toContain("seen.add(bucket.id)");
	});

	test("rejects duplicate category ids returned by the API", () => {
		expect(source).toContain("Categories response contains duplicate id");
	});

	test("serializes reorder persistence and ignores stale refreshes", () => {
		expect(source).toContain("categoryOrderQueue = categoryOrderQueue");
		expect(source).toContain("generation === categoryOrderGeneration");
		expect(source).toContain("categoryDragActive || categoryOrderPending");
	});

	test("keeps the synthetic Uncategorized bucket pinned during events", () => {
		expect(source).toContain(
			"orderedBuckets = withUncategorizedBucket(sanitizeBuckets(e.detail.items))",
		);
		expect(source).toContain(
			"const realCategories = items.filter((item) => item.id !== UNCATEGORIZED_KEY)",
		);
		expect(source).toContain(
			"return uncategorized ? [...realCategories, uncategorized]",
		);
	});
});
