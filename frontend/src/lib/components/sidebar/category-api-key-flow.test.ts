import { describe, expect, it } from "bun:test";
import {
	type CategoryApiAccessDraft,
	issueCategoryKeyAfterSavingAccess,
} from "./category-api-key-flow";

describe("issueCategoryKeyAfterSavingAccess", () => {
	it("persists the edited permissions before issuing the key", async () => {
		const calls: string[] = [];
		const draft: CategoryApiAccessDraft = {
			name: "Product",
			apiMode: "category",
			apiPermissionRead: true,
			apiPermissionEdit: false,
			apiPermissionWrite: true,
		};

		const issued = await issueCategoryKeyAfterSavingAccess({
			categoryId: "category-1",
			draft,
			save: async (payload) => {
				calls.push(`save:${payload.apiMode}:${payload.apiPermissionWrite}`);
				return { id: "category-1", name: payload.name };
			},
			issue: async (categoryId) => {
				calls.push(`issue:${categoryId}`);
				return { id: "key-1", key: "raw-key" };
			},
		});

		expect(calls).toEqual(["save:category:true", "issue:category-1"]);
		expect(issued).toEqual({ id: "key-1", key: "raw-key" });
	});

	it("rejects a category key without any permission", async () => {
		await expect(
			issueCategoryKeyAfterSavingAccess({
				categoryId: "category-1",
				draft: {
					name: "Product",
					apiMode: "category",
					apiPermissionRead: false,
					apiPermissionEdit: false,
					apiPermissionWrite: false,
				},
				save: async () => ({ id: "category-1", name: "Product" }),
				issue: async () => ({ id: "key-1", key: "raw-key" }),
			}),
		).rejects.toThrow("Select at least one permission");
	});
});
