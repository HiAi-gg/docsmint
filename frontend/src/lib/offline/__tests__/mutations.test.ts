import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Document } from "#lib/api/documents.js";
import { cacheDocument } from "#lib/db/documents.js";
import { getOfflineDB } from "#lib/db/index.js";
import type { OfflineIdentity } from "#lib/offline/identity.js";
import { asBunMock } from "./mock-utils";
import { prepareOfflineIdentity } from "./test-identity";

// `mutations.ts` imports the Svelte rune module `network-status.svelte` and
// the API client, so both are mocked and the target is imported dynamically.
let online = true;
mock.module("#lib/offline/network-status.svelte.js", () => ({
	networkStatus: {
		get isOnline() {
			return online;
		},
	},
}));
mock.module("#lib/api/documents.js", () => ({
	getDocument: mock(() => Promise.resolve({} as unknown)),
	listDocuments: mock(() => Promise.resolve({} as unknown)),
	updateDocument: mock(() => Promise.resolve({} as unknown)),
	createDocument: mock(() => Promise.resolve({} as unknown)),
	deleteDocument: mock(() => Promise.resolve(undefined)),
}));

describe("updateDocumentOffline (offline/mutations.ts)", () => {
	let mutations: typeof import("#lib/offline/mutations.js");
	let apiDocs: typeof import("#lib/api/documents.js");
	let draftsDb: typeof import("#lib/db/drafts.js");
	let mqDb: typeof import("#lib/db/mutation-queue.js");
	let identity: OfflineIdentity;

	beforeEach(async () => {
		online = true;
		mutations = await import("#lib/offline/mutations.js");
		apiDocs = await import("#lib/api/documents.js");
		draftsDb = await import("#lib/db/drafts.js");
		mqDb = await import("#lib/db/mutation-queue.js");
		identity = prepareOfflineIdentity();
		const db = getOfflineDB(identity);
		await Promise.all([db.drafts.clear(), db.documents.clear()]);
		asBunMock(apiDocs.updateDocument).mockReset?.();
	});

	it("online: forwards to updateDocument and returns the server doc", async () => {
		const serverDoc = {
			id: "d1",
			title: "Server Title",
			content: "Server Content",
			folderId: null,
			folderName: "",
			categoryId: null,
			tags: [],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-02-01T00:00:00.000Z",
			excerpt: "",
		} as Document;
		asBunMock(apiDocs.updateDocument).mockResolvedValue(serverDoc);

		const result = await mutations.updateDocumentOffline(
			"d1",
			{ title: "Local Title" },
			"2026-01-01T00:00:00.000Z",
		);

		expect(asBunMock(apiDocs.updateDocument).mock.calls).toHaveLength(1);
		expect(asBunMock(apiDocs.updateDocument).mock.calls[0]).toEqual([
			"d1",
			{ title: "Local Title", expectedUpdatedAt: "2026-01-01T00:00:00.000Z" },
		]);
		expect(result).toBe(serverDoc);
		// No local draft should be created while online.
		expect(await draftsDb.getDraft("d1", identity)).toBeNull();
		expect(await mqDb.getPendingCount()).toBe(0);
	});

	it("offline: saves an explicit draft and returns a merged document", async () => {
		online = false;
		// Seed a cached document so the merge has a base.
		await cacheDocument(
			{
				id: "d1",
				title: "Original",
				content: "Original body",
				folderId: null,
				folderName: "",
				categoryId: null,
				tags: [],
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				excerpt: "",
			},
			identity,
		);

		const result = await mutations.updateDocumentOffline(
			"d1",
			{ title: "Merged Title", content: "Merged Body" },
			"2026-01-01T00:00:00.000Z",
		);

		// Server was never called.
		expect(asBunMock(apiDocs.updateDocument).mock.calls).toHaveLength(0);
		// A draft was persisted locally and no queue row exists.
		const draft = await draftsDb.getDraft("d1", identity);
		expect(draft?.patch).toEqual({
			title: "Merged Title",
			content: "Merged Body",
		});
		expect(await mqDb.getPendingCount()).toBe(0);
		// The returned doc is the locally-merged result.
		expect(result.title).toBe("Merged Title");
		expect(result.content).toBe("Merged Body");
		expect(result.id).toBe("d1");
	});
});
