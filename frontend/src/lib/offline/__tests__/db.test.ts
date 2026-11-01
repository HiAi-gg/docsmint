import { beforeEach, describe, expect, it } from "bun:test";
import Dexie from "dexie";
import type { Document } from "#lib/api/documents.js";
import {
	cacheDocument,
	cacheDocuments,
	getCachedDocument,
	getCachedDocuments,
} from "#lib/db/documents.js";
import { clearDraft, getDraft, listDrafts, saveDraft } from "#lib/db/drafts.js";
import { cacheFolder, getCachedFolders } from "#lib/db/folders.js";
import { getOfflineDB, OfflineDB } from "#lib/db/index.js";
import { type OfflineIdentity, offlineDbName } from "#lib/offline/identity.js";
import type { Folder } from "#lib/types.js";
import { prepareOfflineIdentity } from "./test-identity";

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

function makeFolder(id: string, overrides: Partial<Folder> = {}): Folder {
	return {
		id,
		name: `Folder ${id}`,
		parentId: null,
		categoryId: null,
		order: 0,
		documentCount: 0,
		subfolderCount: 0,
		children: [],
		documents: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("OfflineDB (db/index.ts)", () => {
	it("creates a Dexie instance scoped by identity", () => {
		const identity: OfflineIdentity = {
			appId: "hiai-docs",
			deploymentId: "dev",
			ownerId: "owner-1",
		};
		const db = new OfflineDB(identity);
		expect(db).toBeInstanceOf(Dexie);
		expect(db.name).toBe(offlineDbName(identity));
	});

	it("declares the expected schema (version + tables + indexes)", async () => {
		const identity: OfflineIdentity = {
			appId: "hiai-docs",
			deploymentId: "dev",
			ownerId: "owner-2",
		};
		const db = new OfflineDB(identity);
		// v3 removes the legacy mutation queue without replaying it.
		expect(db.verno).toBe(3);
		const tableNames = db.tables.map((t) => t.name).sort();
		expect(tableNames).toEqual(["documents", "drafts", "folders", "metadata"]);
	});

	it("getOfflineDB returns the same instance for the same identity", () => {
		const identity: OfflineIdentity = {
			appId: "hiai-docs",
			deploymentId: "dev",
			ownerId: "owner-3",
		};
		expect(getOfflineDB(identity)).toBe(getOfflineDB(identity));
	});

	it("getOfflineDB returns a different instance for a different identity", () => {
		const a: OfflineIdentity = {
			appId: "hiai-docs",
			deploymentId: "dev",
			ownerId: "owner-a",
		};
		const b: OfflineIdentity = {
			appId: "hiai-docs",
			deploymentId: "dev",
			ownerId: "owner-b",
		};
		expect(getOfflineDB(a)).not.toBe(getOfflineDB(b));
	});
});

describe("document cache helpers (db/documents.ts)", () => {
	let identity: OfflineIdentity;

	beforeEach(async () => {
		identity = prepareOfflineIdentity();
		const db = getOfflineDB(identity);
		await Promise.all([
			db.documents.clear(),
			db.folders.clear(),
			db.drafts.clear(),
			db.metadata.clear(),
		]);
	});

	it("cacheDocument writes a record that getCachedDocument can read", async () => {
		const doc = makeDocument("d1", { title: "Alpha", content: "body" });
		await cacheDocument(doc, identity);
		const cached = await getCachedDocument("d1", identity);
		expect(cached).not.toBeNull();
		expect(cached?.id).toBe("d1");
		expect(cached?.title).toBe("Alpha");
		expect(cached?.content).toBe("body");
	});

	it("getCachedDocument returns null for a missing id", async () => {
		expect(await getCachedDocument("missing", identity)).toBeNull();
	});

	it("getCachedDocuments filters by folderId and sorts by updatedAt desc", async () => {
		await cacheDocuments(
			[
				makeDocument("a", {
					folderId: "f1",
					updatedAt: "2026-01-01T00:00:00.000Z",
				}),
				makeDocument("b", {
					folderId: "f1",
					updatedAt: "2026-03-01T00:00:00.000Z",
				}),
				makeDocument("c", {
					folderId: "f2",
					updatedAt: "2026-02-01T00:00:00.000Z",
				}),
			],
			identity,
		);
		const f1 = await getCachedDocuments("f1", identity);
		expect(f1.map((d) => d.id)).toEqual(["b", "a"]); // newest first
		const all = await getCachedDocuments(undefined, identity);
		expect(all).toHaveLength(3);
	});

	it("cacheDocuments bulk-writes many records", async () => {
		const docs = [makeDocument("x"), makeDocument("y"), makeDocument("z")];
		await cacheDocuments(docs, identity);
		expect(await getCachedDocuments(undefined, identity)).toHaveLength(3);
	});
});

describe("folder cache helpers (db/folders.ts)", () => {
	let identity: OfflineIdentity;

	beforeEach(async () => {
		identity = prepareOfflineIdentity();
		const db = getOfflineDB(identity);
		await db.folders.clear();
	});

	it("cacheFolder writes a folder readable via getCachedFolders", async () => {
		await cacheFolder(
			makeFolder("f1", { name: "Projects", parentId: "root" }),
			identity,
		);
		const folders = await getCachedFolders(identity);
		expect(folders).toHaveLength(1);
		expect(folders[0]?.id).toBe("f1");
		expect(folders[0]?.name).toBe("Projects");
		expect(folders[0]?.parentId).toBe("root");
	});
});

describe("draft helpers (db/drafts.ts)", () => {
	let identity: OfflineIdentity;

	beforeEach(async () => {
		identity = prepareOfflineIdentity();
		const db = getOfflineDB(identity);
		await db.drafts.clear();
	});

	it("saveDraft then getDraft round-trips a draft", async () => {
		await saveDraft(
			"d1",
			{ title: "Edited", content: "new body" },
			"2026-01-01T00:00:00.000Z",
			identity,
		);
		const draft = await getDraft("d1", identity);
		expect(draft).not.toBeNull();
		expect(draft?.patch).toEqual({ title: "Edited", content: "new body" });
		expect(draft?.expectedUpdatedAt).toBe("2026-01-01T00:00:00.000Z");
	});

	it("getDraft returns null when no draft exists", async () => {
		expect(await getDraft("nope", identity)).toBeNull();
	});

	it("clearDraft removes a draft", async () => {
		await saveDraft("d1", { title: "x" }, "2026-01-01T00:00:00.000Z", identity);
		await clearDraft("d1", identity);
		expect(await getDraft("d1", identity)).toBeNull();
	});

	it("listDrafts returns every draft for the identity", async () => {
		await saveDraft("d1", { title: "a" }, "2026-01-01T00:00:00.000Z", identity);
		await saveDraft(
			"d2",
			{ content: "b" },
			"2026-01-01T00:00:00.000Z",
			identity,
		);
		const drafts = await listDrafts(identity);
		expect(drafts).toHaveLength(2);
		expect(drafts.map((d) => d.docId).sort()).toEqual(["d1", "d2"]);
	});
});

describe("mutation queue removal (db/mutation-queue.ts)", () => {
	it("rejects legacy enqueue and never reports pending work", async () => {
		const mq = await import("#lib/db/mutation-queue.js");
		await expect(
			mq.enqueueMutation("d1", "PATCH", {}, "2026-01-01T00:00:00.000Z"),
		).rejects.toThrow("Automatic mutation replay is disabled");
		expect(await mq.getPendingCount()).toBe(0);
		await expect(mq.processQueue()).resolves.toBeUndefined();
	});
});
