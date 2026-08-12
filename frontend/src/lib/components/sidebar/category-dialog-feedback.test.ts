import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ApiError } from "$lib/api/client.js";
import { categoryDialogErrorMessage } from "./category-dialog-feedback.js";

describe("categoryDialogErrorMessage", () => {
	it("turns duplicate-name conflicts into actionable feedback", () => {
		expect(
			categoryDialogErrorMessage(
				new ApiError("Category with this name already exists", 409),
				"Failed to create category",
			),
		).toBe("A category with this name already exists.");
	});

	it("preserves API error details", () => {
		expect(
			categoryDialogErrorMessage(
				new ApiError("CSRF: origin mismatch", 403),
				"Failed to create category",
			),
		).toBe("CSRF: origin mismatch");
	});

	it("uses the fallback for unknown failures", () => {
		expect(categoryDialogErrorMessage(null, "Failed to create category")).toBe(
			"Failed to create category",
		);
	});
});

describe("category dialog mobile layout", () => {
	it("keeps API controls in an internal mobile scroll region", () => {
		const source = readFileSync(
			resolve(import.meta.dir, "CategoryDialog.svelte"),
			"utf8",
		);
		expect(source).toContain("data-category-dialog-scroll");
		expect(source).toContain("max-h-[calc(100dvh-12rem)]");
		expect(source).toContain("overflow-y-auto");
		expect(source).toContain("max-sm:flex-col");
	});
});
