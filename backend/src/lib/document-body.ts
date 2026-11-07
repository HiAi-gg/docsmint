import { isDeepStrictEqual } from "node:util";

type DocumentBody = { content: string | null; contentJson: unknown };

export function sameDocumentBody(
	left: DocumentBody,
	right: DocumentBody,
): boolean {
	return (
		(left.content ?? "") === (right.content ?? "") &&
		isDeepStrictEqual(left.contentJson ?? null, right.contentJson ?? null)
	);
}

export function resolveDocumentBody(
	current: DocumentBody,
	patch: Partial<DocumentBody>,
): DocumentBody {
	const content = patch.content ?? current.content;
	const contentJson =
		patch.contentJson !== undefined
			? patch.contentJson
			: (content ?? "") === (current.content ?? "")
				? current.contentJson
				: null;
	return { content, contentJson };
}
