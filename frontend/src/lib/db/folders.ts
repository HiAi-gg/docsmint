import type { OfflineIdentity } from "#lib/offline/identity.js";
import type { Folder } from "#lib/types.js";
import { type FolderRecord, getOfflineDB } from "./index";

/** Write a single folder into the offline cache. */
export async function cacheFolder(
	folder: Folder,
	identity: OfflineIdentity,
): Promise<void> {
	const db = getOfflineDB(identity);
	const record: FolderRecord = {
		id: folder.id,
		ownerId: identity.ownerId,
		tenantId: identity.tenantId,
		name: folder.name,
		parentId: folder.parentId,
		cachedAt: Date.now(),
	};
	await db.folders.put(record);
}

/** Bulk-write a list of folders into the offline cache. */
export async function cacheFolders(
	folders: Folder[],
	identity: OfflineIdentity,
): Promise<void> {
	if (folders.length === 0) return;
	const db = getOfflineDB(identity);
	const records: FolderRecord[] = folders.map((folder) => ({
		id: folder.id,
		ownerId: identity.ownerId,
		tenantId: identity.tenantId,
		name: folder.name,
		parentId: folder.parentId,
		cachedAt: Date.now(),
	}));
	await db.folders.bulkPut(records);
}

/** Read all cached folders, reconstructed as lightweight `Folder` objects. */
export async function getCachedFolders(
	identity: OfflineIdentity,
): Promise<Folder[]> {
	const db = getOfflineDB(identity);
	const records = await db.folders.toArray();
	return records.map((rec) => ({
		id: rec.id,
		name: rec.name,
		parentId: rec.parentId,
		categoryId: null,
		order: 0,
		documentCount: 0,
		subfolderCount: 0,
		children: [],
		documents: [],
		createdAt: new Date(rec.cachedAt).toISOString(),
		updatedAt: new Date(rec.cachedAt).toISOString(),
	}));
}
