import { describe, expect, test } from "bun:test";
import { folderNamesForSearchCategory } from "./search-folder-options";

const folders = [
	{ id: "root-a", name: "Root A", parentId: null, categoryId: "category-a" },
	{ id: "child-a", name: "Child A", parentId: "root-a", categoryId: null },
	{ id: "root-b", name: "Root B", parentId: null, categoryId: "category-b" },
	{ id: "loose", name: "Loose", parentId: null, categoryId: null },
];

describe("search folder options", () => {
	test("keeps all server options when no category is selected", () => {
		expect(
			folderNamesForSearchCategory(
				["Root A", "Child A", "Root B", "Loose"],
				folders,
				"",
			),
		).toEqual(["Root A", "Child A", "Root B", "Loose"]);
	});

	test("shows direct and inherited folders only for the selected category", () => {
		expect(folderNamesForSearchCategory([], folders, "category-a")).toEqual([
			"Root A",
			"Child A",
		]);
	});
});
