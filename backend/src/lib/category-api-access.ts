export type CategoryApiMode = "unavailable" | "global" | "category";

export type CategoryApiAccessState = {
	apiMode: CategoryApiMode;
	apiPermissionRead: boolean;
	apiPermissionEdit: boolean;
	apiPermissionWrite: boolean;
};

export function normalizeApiMode(apiMode?: string | null): CategoryApiMode {
	if (apiMode === "category") return "category";
	if (apiMode === "global") return "global";
	return "unavailable";
}

/** Merge a partial category API PATCH onto the locked current row. */
export function buildApiAccessValues(input: {
	apiMode?: string | null;
	apiPermissionRead?: boolean;
	apiPermissionEdit?: boolean;
	apiPermissionWrite?: boolean;
	existing?: {
		apiMode: string;
		apiPermissionRead: boolean;
		apiPermissionEdit: boolean;
		apiPermissionWrite: boolean;
	};
}): CategoryApiAccessState {
	const existing = input.existing ?? {
		apiMode: "unavailable",
		apiPermissionRead: false,
		apiPermissionEdit: false,
		apiPermissionWrite: false,
	};

	const apiMode =
		input.apiMode !== undefined
			? normalizeApiMode(input.apiMode)
			: normalizeApiMode(existing.apiMode);

	const apiPermissionRead =
		input.apiPermissionRead !== undefined
			? input.apiPermissionRead
			: existing.apiPermissionRead;
	const apiPermissionEdit =
		input.apiPermissionEdit !== undefined
			? input.apiPermissionEdit
			: existing.apiPermissionEdit;
	const apiPermissionWrite =
		input.apiPermissionWrite !== undefined
			? input.apiPermissionWrite
			: existing.apiPermissionWrite;

	if (apiMode === "unavailable") {
		return {
			apiMode,
			apiPermissionRead: false,
			apiPermissionEdit: false,
			apiPermissionWrite: false,
		};
	}

	return {
		apiMode,
		apiPermissionRead,
		apiPermissionEdit,
		apiPermissionWrite,
	};
}
