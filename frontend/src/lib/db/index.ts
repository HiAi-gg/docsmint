import Dexie, { type Table } from "dexie";
import { type OfflineIdentity, offlineDbName } from "#lib/offline/identity.js";

/** A document cached from the server for offline reading. */
export interface DocumentRecord {
	id: string;
	ownerId: string;
	tenantId?: string;
	title: string;
	content?: string;
	folderId: string | null;
	updatedAt: string;
	/** Timestamp (ms) when this row was written to the cache. */
	cachedAt: number;
}

/** A folder cached from the server for offline reading. */
export interface FolderRecord {
	id: string;
	ownerId: string;
	tenantId?: string;
	name: string;
	parentId: string | null;
	cachedAt: number;
}

/** A local, unsynced edit to a document. */
export interface DraftRecord {
	docId: string;
	ownerId: string;
	tenantId?: string;
	patch: { title?: string; content?: string; contentJson?: unknown };
	/** Alias used by the explicit Apply draft flow. */
	baseUpdatedAt?: string;
	/** The document's `updatedAt` when the edit began (for conflict checks). */
	expectedUpdatedAt: string;
	updatedAt: number;
}

export type MutationOp = "PATCH" | "POST" | "DELETE";
export type MutationStatus = "pending" | "syncing" | "failed";

/** A queued mutation replayed when connectivity returns. */
export interface MutationRecord {
	id?: number;
	docId: string;
	op: MutationOp;
	payload: unknown;
	expectedUpdatedAt: string;
	status: MutationStatus;
	createdAt: number;
}

/** Arbitrary key/value metadata (e.g. last-sync timestamps). */
export interface MetadataRecord {
	key: string;
	value: unknown;
}

/**
 * Dexie-backed offline database. One instance per offline identity; the
 * instance is scoped by `offlineDbName(identity)`.
 */
export class OfflineDB extends Dexie {
	documents!: Table<DocumentRecord, string>;
	folders!: Table<FolderRecord, string>;
	drafts!: Table<DraftRecord, string>;
	mutationQueue!: Table<MutationRecord, number>;
	metadata!: Table<MetadataRecord, string>;

	constructor(identity: OfflineIdentity) {
		super(offlineDbName(identity));
		this.version(1).stores({
			documents: "id, ownerId, tenantId, folderId, updatedAt",
			folders: "id, ownerId, tenantId, parentId, name",
			drafts: "docId, ownerId, tenantId, updatedAt",
			mutationQueue: "++id, docId, op, status",
			metadata: "key",
		});
		// v2 indexes `createdAt` on the mutation queue so `processQueue`
		// can replay queued mutations in FIFO order via `orderBy("createdAt")`.
		this.version(2).stores({
			documents: "id, ownerId, tenantId, folderId, updatedAt",
			folders: "id, ownerId, tenantId, parentId, name",
			drafts: "docId, ownerId, tenantId, updatedAt",
			mutationQueue: "++id, docId, op, status, createdAt",
			metadata: "key",
		});
		// v3 removes the legacy mutation queue. Existing queued rows are
		// discarded during upgrade; they are never replayed.
		this.version(3).stores({
			documents: "id, ownerId, tenantId, folderId, updatedAt",
			folders: "id, ownerId, tenantId, parentId, name",
			drafts: "docId, ownerId, tenantId, updatedAt",
			mutationQueue: null,
			metadata: "key",
		});
	}
}

const dbCache = new Map<string, OfflineDB>();

/**
 * Get (or create and cache) the offline DB for the given identity. The same
 * identity always returns the same Dexie instance so connections and
 * in-flight transactions are shared.
 */
export function getOfflineDB(identity: OfflineIdentity): OfflineDB {
	const name = offlineDbName(identity);
	let db = dbCache.get(name);
	if (!db) {
		db = new OfflineDB(identity);
		dbCache.set(name, db);
	}
	return db;
}

export async function deleteOfflineDB(
	identity: OfflineIdentity,
): Promise<void> {
	const name = offlineDbName(identity);
	const db = dbCache.get(name);
	if (db) {
		await db.delete();
		dbCache.delete(name);
		return;
	}
	await Dexie.delete(name);
}
