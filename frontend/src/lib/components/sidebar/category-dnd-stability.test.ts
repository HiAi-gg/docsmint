import { describe, expect, test } from "bun:test";

const source = await Bun.file(`${import.meta.dir}/FolderTree.svelte`).text();

describe("category drag-and-drop stability", () => {
	test("preserves the dnd shadow item throughout consider events", () => {
		expect(source).toMatch(
			/orderedBuckets\s*=\s*withUncategorizedBucket\(\s*validCategoryDndItems\(e\.detail\.items\)/,
		);
		expect(source).toContain("result.push(bucket)");
		expect(source).toContain("data-is-dnd-shadow-item-hint");
		expect(source).toContain(
			'SHADOW_ITEM_MARKER_PROPERTY_NAME] ? "shadow" : "item"',
		);
		expect(source).not.toContain("ignored duplicate category DnD item");
	});

	test("uses the shadow position when finalizing a legacy duplicate event", () => {
		expect(source).toContain("finalizeCategoryDndItems(e.detail.items)");
		expect(source).toContain("const shadowIds = new Set(");
		expect(source).toMatch(
			/if\s*\(shadowIds\.has\(item\.id\)\s*&&\s*!item\[SHADOW_ITEM_MARKER_PROPERTY_NAME\]\)\s*continue/,
		);
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
		expect(source).toMatch(
			/orderedBuckets\s*=\s*withUncategorizedBucket\(\s*validCategoryDndItems\(e\.detail\.items\)/,
		);
		expect(source).toContain(
			"const realCategories = items.filter((item) => item.id !== UNCATEGORIZED_KEY)",
		);
		expect(source).toContain(
			"return uncategorized ? [...realCategories, uncategorized]",
		);
	});
});
