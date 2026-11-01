import type { JSONContent } from "@tiptap/core";
import { getOfflineDB } from "#lib/db/index.js";
import { resolveOfflineIdentity } from "#lib/offline/identity.js";

const CACHE_PREFIX = "parsed-editor-content";

export function parsedContentCacheKey(
	documentId: string,
	updatedAt: string,
): string {
	return `${CACHE_PREFIX}:${documentId}:${updatedAt}`;
}

export async function getCachedParsedContent(
	documentId: string,
	updatedAt: string,
): Promise<JSONContent | null> {
	try {
		const identity = await resolveOfflineIdentity();
		const row = await getOfflineDB(identity).metadata.get(
			parsedContentCacheKey(documentId, updatedAt),
		);
		return (row?.value as JSONContent | undefined) ?? null;
	} catch {
		return null;
	}
}

export async function cacheParsedContent(
	documentId: string,
	updatedAt: string,
	content: JSONContent,
): Promise<void> {
	try {
		const identity = await resolveOfflineIdentity();
		const db = getOfflineDB(identity);
		const currentKey = parsedContentCacheKey(documentId, updatedAt);
		const staleKeys = await db.metadata
			.filter(
				(row) =>
					row.key.startsWith(`${CACHE_PREFIX}:${documentId}:`) &&
					row.key !== currentKey,
			)
			.primaryKeys();
		await db.transaction("rw", db.metadata, async () => {
			if (staleKeys.length > 0) await db.metadata.bulkDelete(staleKeys);
			await db.metadata.put({ key: currentKey, value: content });
		});
	} catch {
		// The cache is an optional acceleration layer. Parsing still succeeds
		// when IndexedDB or the authenticated identity is unavailable.
	}
}
