import type { OfflineIdentity } from "#lib/offline/identity.js";
import { type DraftRecord, getOfflineDB } from "./index";

/** Persist (or replace) a local draft for a document. */
export async function saveDraft(
	docId: string,
	patch: { title?: string; content?: string; contentJson?: unknown },
	expectedUpdatedAt: string,
	identity: OfflineIdentity,
): Promise<void> {
	const db = getOfflineDB(identity);
	const record: DraftRecord = {
		docId,
		ownerId: identity.ownerId,
		tenantId: identity.tenantId,
		patch,
		expectedUpdatedAt,
		baseUpdatedAt: expectedUpdatedAt,
		updatedAt: Date.now(),
	};
	await db.drafts.put(record);
}

/** Read the local draft for a document, or null if none. */
export async function getDraft(
	docId: string,
	identity: OfflineIdentity,
): Promise<DraftRecord | null> {
	const db = getOfflineDB(identity);
	return (await db.drafts.get(docId)) ?? null;
}

/** Remove a local draft (e.g. after a successful sync). */
export async function clearDraft(
	docId: string,
	identity: OfflineIdentity,
): Promise<void> {
	const db = getOfflineDB(identity);
	await db.drafts.delete(docId);
}

/** List all local drafts for the current identity. */
export async function listDrafts(
	identity: OfflineIdentity,
): Promise<DraftRecord[]> {
	const db = getOfflineDB(identity);
	return db.drafts.toArray();
}
