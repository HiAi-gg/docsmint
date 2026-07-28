export type CategoryApiAccessDraft = {
	name: string;
	apiMode: "unavailable" | "global" | "category";
	apiPermissionRead: boolean;
	apiPermissionEdit: boolean;
	apiPermissionWrite: boolean;
};

type SavedCategory = { id: string; name: string };
type IssuedCategoryKey = { id: string; key: string };

export async function issueCategoryKeyAfterSavingAccess(input: {
	categoryId: string;
	draft: CategoryApiAccessDraft;
	save: (draft: CategoryApiAccessDraft) => Promise<SavedCategory | undefined>;
	issue: (categoryId: string) => Promise<IssuedCategoryKey>;
}): Promise<IssuedCategoryKey> {
	if (!input.draft.name.trim()) throw new Error("Name is required");
	if (input.draft.apiMode !== "category") {
		throw new Error("Select Category API access");
	}
	if (
		!input.draft.apiPermissionRead &&
		!input.draft.apiPermissionEdit &&
		!input.draft.apiPermissionWrite
	) {
		throw new Error("Select at least one permission");
	}

	const saved = await input.save(input.draft);
	if (!saved || saved.id !== input.categoryId) {
		throw new Error("Failed to save Category API access");
	}
	return input.issue(input.categoryId);
}
