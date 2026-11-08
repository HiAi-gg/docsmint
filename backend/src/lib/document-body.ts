import { isDeepStrictEqual } from "node:util";
import { versions } from "@hiai-docs/db/schema";
import { sql } from "drizzle-orm";

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

// The newest restore marker is a durable collaboration generation. Pruning
// keeps this marker so old room keys cannot become current again.
export function latestDocumentRestore(documentId: string) {
	return sql<string | null>`(
		SELECT ${versions.id}
		FROM ${versions}
		WHERE ${versions.documentId} = ${documentId}
		  AND ${versions.restoredFrom} IS NOT NULL
		ORDER BY ${versions.createdAt} DESC, ${versions.id} DESC
		LIMIT 1
	)`;
}
