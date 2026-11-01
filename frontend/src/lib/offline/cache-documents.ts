import {
	type Document,
	type DocumentListResponse,
	getDocument,
	listDocuments,
} from "#lib/api/documents.js";
import { listFolders } from "#lib/api/folders.js";
import {
	cacheDocument,
	cacheDocuments,
	getCachedDocument as dbGetCachedDocument,
	getCachedDocuments as dbGetCachedDocuments,
} from "#lib/db/documents.js";
import { cacheFolders, getCachedFolders } from "#lib/db/folders.js";
import type { Folder } from "#lib/types.js";
import { offlineAccessEnabled, resolveOfflineIdentity } from "./identity";

/**
 * True for a network-level failure (offline / DNS / CORS) as opposed to an
 * HTTP error or an abort. `apiFetch` re-throws the raw `TypeError` that the
 * browser's `fetch` raises when a request cannot be completed, so we key
 * off that to decide when to fall back to the local cache.
 */
function isNetworkError(err: unknown): boolean {
	return err instanceof TypeError;
}

/**
 * Cache a successful online read without putting IndexedDB or the session
 * lookup on the critical path. Offline storage is progressive enhancement:
 * when the user has not opted in (or storage is unavailable), the original
 * online response is still returned unchanged.
 */
function writeThrough(
	write: (
		identity: Awaited<ReturnType<typeof resolveOfflineIdentity>>,
	) => Promise<void>,
): void {
	if (!offlineAccessEnabled()) return;
	void resolveOfflineIdentity()
		.then(write)
		.catch(() => {});
}

async function resolveFallbackIdentity(originalError: unknown) {
	try {
		return await resolveOfflineIdentity();
	} catch {
		// Preserve the network failure that triggered the fallback. A missing or
		// expired offline binding must not replace it with an identity error.
		throw originalError;
	}
}

/**
 * Get a document, caching it on success and falling back to the local
 * Dexie cache (flagged `stale`) when the network is unavailable.
 */
export async function getDocumentCached(
	id: string,
	fetcher?: typeof fetch,
): Promise<Document & { stale?: boolean }> {
	try {
		const doc = await getDocument(id, fetcher);
		writeThrough((identity) => cacheDocument(doc, identity));
		return doc;
	} catch (err) {
		if (isNetworkError(err)) {
			const identity = await resolveFallbackIdentity(err);
			const cached = await dbGetCachedDocument(id, identity);
			if (cached) return { ...cached, stale: true };
		}
		throw err;
	}
}

/**
 * List documents, caching them on success and falling back to the local
 * Dexie cache (flagged `stale`) when the network is unavailable.
 */
export async function listDocumentsCached(
	params?: {
		folderId?: string;
		tag?: string;
		page?: number;
		limit?: number;
	},
	fetcher?: typeof fetch,
): Promise<DocumentListResponse & { stale?: boolean }> {
	try {
		const res = await listDocuments(params, fetcher);
		writeThrough((identity) => cacheDocuments(res.items, identity));
		return res;
	} catch (err) {
		if (isNetworkError(err)) {
			const identity = await resolveFallbackIdentity(err);
			const cached = await dbGetCachedDocuments(params?.folderId, identity);
			if (cached.length > 0) {
				return {
					items: cached,
					total: cached.length,
					page: 1,
					limit: cached.length,
					stale: true,
				};
			}
		}
		throw err;
	}
}

/**
 * List folders, caching them on success and falling back to the local
 * Dexie cache (flagged `stale`) when the network is unavailable. The
 * synthetic "root" folder returned by `listFolders(null)` is never cached.
 */
export async function listFoldersCached(
	parentId: string | null = null,
	all = false,
	fetcher?: typeof fetch,
): Promise<Folder[] & { stale?: boolean }> {
	try {
		const folders = await listFolders(parentId, all, fetcher);
		const real = folders.flatMap((folder) =>
			folder.id === "root" ? folder.children : [folder],
		);
		writeThrough((identity) => cacheFolders(real, identity));
		return folders as Folder[] & { stale?: boolean };
	} catch (err) {
		if (isNetworkError(err)) {
			const identity = await resolveFallbackIdentity(err);
			const allCached = await getCachedFolders(identity);
			const cached = all
				? allCached
				: allCached.filter((folder) => folder.parentId === parentId);
			if (cached.length > 0) {
				const result = (
					parentId === null && !all
						? [
								{
									id: "root",
									name: "Workspace",
									parentId: null,
									categoryId: null,
									order: 0,
									documentCount: 0,
									subfolderCount: 0,
									children: cached,
									documents: [],
									createdAt: new Date().toISOString(),
									updatedAt: new Date().toISOString(),
								},
							]
						: cached.slice()
				) as Folder[] & { stale?: boolean };
				result.stale = true;
				return result;
			}
		}
		throw err;
	}
}

// --- Direct cache reads (no network attempt) ---

/** Read a single cached document by id. */
export async function getCachedDocument(id: string): Promise<Document | null> {
	const identity = await resolveOfflineIdentity();
	return dbGetCachedDocument(id, identity);
}

/** Read cached documents, optionally filtered by folder. */
export async function getCachedDocuments(
	folderId?: string,
): Promise<Document[]> {
	const identity = await resolveOfflineIdentity();
	return dbGetCachedDocuments(folderId, identity);
}
