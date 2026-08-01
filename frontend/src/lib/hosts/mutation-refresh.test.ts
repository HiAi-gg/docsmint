import { describe, expect, it } from "bun:test";
import { mutationRefreshImpact } from "./mutation-refresh";

describe("mutationRefreshImpact", () => {
	it("refreshes document and folder projections after taxonomy mutations", () => {
		expect(
			mutationRefreshImpact("/api/categories/category-1", {
				method: "PATCH",
			}),
		).toEqual({ documents: true, folders: true, tags: false });
		expect(
			mutationRefreshImpact("/api/folders/folder-1", { method: "DELETE" }),
		).toEqual({ documents: true, folders: true, tags: false });
	});

	it("refreshes tag and document projections after assigning a tag", () => {
		expect(
			mutationRefreshImpact("/api/documents/document-1/tags/tag-1", {
				method: "POST",
			}),
		).toEqual({ documents: true, folders: false, tags: true });
	});

	it("refreshes document and folder projections after Trash restore", () => {
		expect(
			mutationRefreshImpact("/api/trash/documents/document-1/restore", {
				method: "POST",
			}),
		).toEqual({ documents: true, folders: true, tags: false });
		expect(
			mutationRefreshImpact("/api/trash/folders/folder-1/restore", {
				method: "POST",
			}),
		).toEqual({ documents: true, folders: true, tags: false });
	});

	it("does not invalidate navigation for reads or unrelated mutations", () => {
		expect(mutationRefreshImpact("/api/documents", { method: "GET" })).toEqual({
			documents: false,
			folders: false,
			tags: false,
		});
		expect(mutationRefreshImpact("/api/v1/keys", { method: "POST" })).toEqual({
			documents: false,
			folders: false,
			tags: false,
		});
		expect(
			mutationRefreshImpact("/api/categories/category-1/keys", {
				method: "POST",
			}),
		).toEqual({ documents: false, folders: false, tags: false });
	});
});
