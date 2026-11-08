export function createYjsRoomKey(input: {
	documentId: string;
	userId: string;
	workspaceId?: string;
	restoreVersionId?: string | null;
}): string {
	const scope = input.workspaceId
		? `workspace:${input.workspaceId}`
		: `user:${input.userId}`;
	const base = `${scope}:document:${input.documentId}`;
	return input.restoreVersionId
		? `${base}:restore:${input.restoreVersionId}`
		: base;
}
