import {
	type Document,
	type UpdateDocumentInput,
	updateDocument,
} from "#lib/api/documents.js";
import { getCachedDocument } from "#lib/db/documents.js";
import { saveDraft } from "#lib/db/drafts.js";
import { resolveOfflineIdentity } from "./identity";
import { networkStatus } from "./network-status.svelte";

/**
 * Offline-aware document update.
 *
 * - Online: forwards to the server (passing `expectedUpdatedAt` so the
 *   backend can detect conflicts) and returns the server document.
 * - Offline: stores the edit as an explicit local draft and returns a
 *   locally-merged document so the UI can update immediately. It never
 *   queues or replays a network mutation.
 *
 * This is a wrapper around `updateDocument` — `apiFetch` is intentionally
 * left untouched per the project constraints.
 */
export async function updateDocumentOffline(
	id: string,
	data: UpdateDocumentInput,
	expectedUpdatedAt: string,
): Promise<Document> {
	const identity = await resolveOfflineIdentity();

	if (networkStatus.isOnline) {
		return updateDocument(id, { ...data, expectedUpdatedAt });
	}

	// Offline edits are explicit local drafts only. v1 never replays mutations
	// automatically when connectivity returns.
	await saveDraft(
		id,
		{ title: data.title, content: data.content },
		expectedUpdatedAt,
		identity,
	);

	const cached = await getCachedDocument(id, identity);
	const base: Document = cached ?? {
		id,
		title: data.title ?? "",
		content: data.content ?? "",
		folderId: null,
		folderName: "",
		categoryId: undefined,
		tags: [],
		createdAt: new Date().toISOString(),
		updatedAt: expectedUpdatedAt,
		excerpt: "",
	};

	return {
		...base,
		title: data.title ?? base.title,
		content: data.content ?? base.content,
		updatedAt: new Date().toISOString(),
	};
}
