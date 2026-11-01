import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Document } from "#lib/api/documents.js";
import { asBunMock } from "./mock-utils";
import { prepareOfflineIdentity } from "./test-identity";

// API modules are mocked; targets are imported dynamically after the mocks
// are registered (mock.module is not hoisted).
mock.module("#lib/api/documents.js", () => ({
	getDocument: mock(() => Promise.resolve({} as unknown)),
	listDocuments: mock(() => Promise.resolve({} as unknown)),
	updateDocument: mock(() => Promise.resolve({} as unknown)),
	createDocument: mock(() => Promise.resolve({} as unknown)),
	deleteDocument: mock(() => Promise.resolve(undefined)),
}));
mock.module("#lib/api/folders.js", () => ({
	listFolders: mock(() => Promise.resolve([] as unknown)),
}));

function makeDocument(id: string, overrides: Partial<Document> = {}): Document {
	return {
		id,
		title: `Doc ${id}`,
		content: `content ${id}`,
		folderId: null,
		folderName: "",
		categoryId: null,
		tags: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		excerpt: "",
		...overrides,
	};
}

async function waitFor(
	condition: () => boolean | Promise<boolean>,
): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (await condition()) return;
		await Bun.sleep(2);
	}
	throw new Error("Timed out waiting for best-effort cache write");
}

describe("cache-documents (offline/cache-documents.ts)", () => {
	let cache: typeof import("#lib/offline/cache-documents.js");
	let docsDb: typeof import("#lib/db/documents.js");
	let foldersDb: typeof import("#lib/db/folders.js");
	let apiDocs: typeof import("#lib/api/documents.js");
	let apiFolders: typeof import("#lib/api/folders.js");
	let identity: import("#lib/offline/identity.js").OfflineIdentity;

	beforeEach(async () => {
		cache = await import("#lib/offline/cache-documents.js");
		docsDb = await import("#lib/db/documents.js");
		foldersDb = await import("#lib/db/folders.js");
		apiDocs = await import("#lib/api/documents.js");
		apiFolders = await import("#lib/api/folders.js");
		const { getOfflineDB } = await import("#lib/db/index.js");
		identity = prepareOfflineIdentity();
		const db = getOfflineDB(identity);
		await Promise.all([db.documents.clear(), db.folders.clear()]);
		asBunMock(apiDocs.getDocument).mockReset?.();
		asBunMock(apiDocs.listDocuments).mockReset?.();
		asBunMock(apiFolders.listFolders).mockReset?.();
	});

	describe("getDocumentCached", () => {
		it("caches the document on network success", async () => {
			const doc = makeDocument("d1", { title: "Alpha" });
			const fetcher = globalThis.fetch;
			asBunMock(apiDocs.getDocument).mockResolvedValue(doc);
			const res = await cache.getDocumentCached("d1", fetcher);
			expect(res.id).toBe("d1");
			expect(res.stale).toBeUndefined();
			expect(apiDocs.getDocument).toHaveBeenCalledWith("d1", fetcher);
			await waitFor(
				async () =>
					(await docsDb.getCachedDocument("d1", identity))?.title === "Alpha",
			);
			const cached = await docsDb.getCachedDocument("d1", identity);
			expect(cached?.title).toBe("Alpha");
		});

		it("returns an online response when offline access is disabled", async () => {
			const { disableOfflineAccess } = await import("#lib/offline/identity.js");
			disableOfflineAccess();
			const doc = makeDocument("online");
			asBunMock(apiDocs.getDocument).mockResolvedValue(doc);

			await expect(cache.getDocumentCached("online")).resolves.toEqual(doc);
			expect(await docsDb.getCachedDocument("online", identity)).toBeNull();
		});

		it("falls back to the Dexie cache (stale) on a network error", async () => {
			asBunMock(apiDocs.getDocument).mockRejectedValue(
				new TypeError("network down"),
			);
			await docsDb.cacheDocument(
				makeDocument("d1", { title: "Cached" }),
				identity,
			);
			const res = await cache.getDocumentCached("d1");
			expect(res.stale).toBe(true);
			expect(res.title).toBe("Cached");
		});

		it("re-throws when offline and nothing is cached", async () => {
			asBunMock(apiDocs.getDocument).mockRejectedValue(
				new TypeError("network down"),
			);
			await expect(cache.getDocumentCached("missing")).rejects.toBeInstanceOf(
				TypeError,
			);
		});

		it("does not mask a non-network error with cached data", async () => {
			const serverError = new Error("HTTP 500");
			await docsDb.cacheDocument(makeDocument("d1"), identity);
			asBunMock(apiDocs.getDocument).mockRejectedValue(serverError);

			await expect(cache.getDocumentCached("d1")).rejects.toBe(serverError);
		});
	});

	describe("listDocumentsCached", () => {
		it("caches the listing on network success", async () => {
			const res = {
				items: [makeDocument("a"), makeDocument("b")],
				total: 2,
				page: 1,
				limit: 10,
			};
			asBunMock(apiDocs.listDocuments).mockResolvedValue(res);
			const out = await cache.listDocumentsCached();
			expect(out.total).toBe(2);
			expect(out.stale).toBeUndefined();
			await waitFor(
				async () =>
					(await docsDb.getCachedDocuments(undefined, identity)).length === 2,
			);
			expect(await docsDb.getCachedDocuments(undefined, identity)).toHaveLength(
				2,
			);
		});

		it("falls back to the Dexie cache (stale) on a network error", async () => {
			asBunMock(apiDocs.listDocuments).mockRejectedValue(
				new TypeError("network down"),
			);
			await docsDb.cacheDocuments(
				[
					makeDocument("a", { folderId: "f1" }),
					makeDocument("b", { folderId: "f1" }),
				],
				identity,
			);
			const out = await cache.listDocumentsCached({ folderId: "f1" });
			expect(out.stale).toBe(true);
			expect(out.items).toHaveLength(2);
			expect(out.total).toBe(2);
		});
	});

	describe("listFoldersCached", () => {
		it("caches real folders (skipping the synthetic root) on success", async () => {
			const f1 = {
				id: "f1",
				name: "Folder One",
				parentId: null,
				categoryId: null,
				order: 0,
				documentCount: 0,
				subfolderCount: 0,
				children: [],
				documents: [],
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			};
			const root = {
				...f1,
				id: "root",
				name: "Workspace",
				children: [f1],
			};
			asBunMock(apiFolders.listFolders).mockResolvedValue([root]);
			const out = await cache.listFoldersCached(null);
			expect(out).toHaveLength(1);
			expect(out[0]?.id).toBe("root");
			expect(out[0]?.children.map((folder) => folder.id)).toEqual(["f1"]);
			// root is never written to the cache
			await waitFor(
				async () => (await foldersDb.getCachedFolders(identity)).length === 1,
			);
			const cached = await foldersDb.getCachedFolders(identity);
			expect(cached).toHaveLength(1);
			expect(cached[0]?.id).toBe("f1");
		});

		it("falls back to the Dexie cache (stale) on a network error", async () => {
			asBunMock(apiFolders.listFolders).mockRejectedValue(
				new TypeError("network down"),
			);
			await foldersDb.cacheFolder(
				{
					id: "f1",
					name: "Folder One",
					parentId: null,
					categoryId: null,
					order: 0,
					documentCount: 0,
					subfolderCount: 0,
					children: [],
					documents: [],
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
				identity,
			);
			const out = await cache.listFoldersCached(null);
			expect(out.stale).toBe(true);
			expect(out).toHaveLength(1);
			expect(out[0]?.id).toBe("root");
			expect(out[0]?.children.map((folder) => folder.id)).toEqual(["f1"]);
		});
	});
});
