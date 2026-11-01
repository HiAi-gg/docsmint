/** PostgreSQL LEFT(text, 200) and this helper both count Unicode code points. */
export function documentPreview(content: string | null | undefined): string {
	return Array.from(content ?? "")
		.slice(0, 200)
		.join("");
}

/** Uses a trusted configured application URL, never a request Host header. */
export function documentLocation(
	id: string,
	workspaceId?: string | null,
	publicAppUrl?: string,
) {
	const path = `/docs/${encodeURIComponent(id)}`;
	return {
		workspaceId: workspaceId ?? null,
		workspaceSlug: null,
		url: publicAppUrl ? `${publicAppUrl.replace(/\/+$/, "")}${path}` : path,
	};
}

export function withDocumentPreview<
	T extends { id: string; content?: string | null },
>(row: T, workspaceId?: string | null, publicAppUrl?: string) {
	const preview = documentPreview(row.content);
	return {
		...row,
		content: preview,
		preview,
		...documentLocation(row.id, workspaceId, publicAppUrl),
	};
}
