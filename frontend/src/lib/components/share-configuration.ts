export type ShareDisplayMode = "host-managed" | "standalone";
export type ShareAccessMode = "public" | "restricted";
export type ShareGuestRole = "viewer" | "commenter" | "editor";

export interface ShareConfigurationInput {
	displayMode: ShareDisplayMode;
	documentId: string;
	folderId: string;
	categoryId: string;
	usePassword: boolean;
	password: string;
	expiresIn: "1h" | "1d" | "7d" | "30d" | "never";
	accessMode: ShareAccessMode;
	allowPasswordFallback: boolean;
	guests: Array<{ email: string; role: ShareGuestRole }>;
}

export function shareAccessModesForDisplay(
	displayMode: ShareDisplayMode,
): ShareAccessMode[] {
	return displayMode === "standalone" ? ["public"] : ["public", "restricted"];
}

export function buildShareLinkRequest(input: ShareConfigurationInput): {
	documentId?: string;
	folderId?: string;
	categoryId?: string;
	password?: string;
	expiresIn: ShareConfigurationInput["expiresIn"];
	accessMode: ShareAccessMode;
	allowPasswordFallback?: boolean;
	guests?: Array<{ email: string; role: ShareGuestRole }>;
} {
	const accessMode =
		input.displayMode === "standalone" ? "public" : input.accessMode;
	const restricted = accessMode === "restricted";
	return {
		documentId: input.documentId || undefined,
		folderId: input.folderId || undefined,
		categoryId: input.categoryId || undefined,
		password: input.usePassword ? input.password : undefined,
		expiresIn: input.expiresIn,
		accessMode,
		allowPasswordFallback:
			restricted && input.usePassword ? input.allowPasswordFallback : undefined,
		guests: restricted ? input.guests : undefined,
	};
}
