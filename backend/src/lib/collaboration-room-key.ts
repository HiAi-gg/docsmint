export function createYjsRoomKey(input: {
	documentId: string;
	userId: string;
	workspaceId?: string;
}): string {
	const scope = input.workspaceId
		? `workspace:${input.workspaceId}`
		: `user:${input.userId}`;
	return `${scope}:document:${input.documentId}`;
}
