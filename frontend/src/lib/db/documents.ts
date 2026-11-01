import type { Document } from "#lib/api/documents.js";
import type { OfflineIdentity } from "#lib/offline/identity.js";
import { type DocumentRecord, getOfflineDB } from "./index";

/** Write a single document into the offline cache. */
export async function cacheDocument(
	doc: Document,
	identity: OfflineIdentity,
): Promise<void> {
	const db = getOfflineDB(identity);
	const record: DocumentRecord = {
		id: doc.id,
		ownerId: identity.ownerId,
		tenantId: identity.tenantId,
		title: doc.title,
		content: doc.content,
		folderId: doc.folderId ?? null,
		updatedAt: doc.updatedAt,
		cachedAt: Date.now(),
	};
	await db.documents.put(record);
}

/** Bulk-write a list of documents into the offline cache. */
export async function cacheDocuments(
	docs: Document[],
	identity: OfflineIdentity,
): Promise<void> {
	if (docs.length === 0) return;
	const db = getOfflineDB(identity);
	const records: DocumentRecord[] = docs.map((doc) => ({
		id: doc.id,
		ownerId: identity.ownerId,
		tenantId: identity.tenantId,
		title: doc.title,
		content: doc.content,
		folderId: doc.folderId ?? null,
		updatedAt: doc.updatedAt,
		cachedAt: Date.now(),
	}));
	await db.documents.bulkPut(records);
}

/** Reconstruct an API `Document` from a cached record. */
function recordToDocument(rec: DocumentRecord): Document {
	const content = rec.content ?? "";
	return {
		id: rec.id,
		title: rec.title,
		content,
		folderId: rec.folderId,
		folderName: "",
		categoryId: undefined,
		tags: [],
		createdAt: rec.updatedAt,
		updatedAt: rec.updatedAt,
		excerpt: content.length > 200 ? `${content.slice(0, 200)}…` : content,
	};
}

/** Read a single cached document by id, or null if not cached. */
export async function getCachedDocument(
	id: string,
	identity: OfflineIdentity,
): Promise<Document | null> {
	const db = getOfflineDB(identity);
	const rec = await db.documents.get(id);
	return rec ? recordToDocument(rec) : null;
}

/**
 * Read cached documents. When `folderId` is provided only documents in that
 * folder are returned; otherwise all cached documents are returned.
 */
export async function getCachedDocuments(
	folderId: string | undefined,
	identity: OfflineIdentity,
): Promise<Document[]> {
	const db = getOfflineDB(identity);
	const all = await db.documents.toArray();
	const filtered = folderId
		? all.filter((rec) => rec.folderId === folderId)
		: all;
	return filtered
		.map(recordToDocument)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
