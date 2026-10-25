import { beforeEach, describe, expect, it, mock } from "bun:test";
import { getOfflineDB } from "#lib/db/index.js";
import { cleanupOfflineData } from "#lib/offline/cleanup.js";
import type { OfflineIdentity } from "#lib/offline/identity.js";
import { prepareOfflineIdentity } from "./test-identity";

describe("cleanupOfflineData (offline/cleanup.ts)", () => {
	let identity: OfflineIdentity;
	let deleteMock: ReturnType<typeof mock<(name: string) => Promise<boolean>>>;
	let postMessage: ReturnType<typeof mock<(msg: unknown) => void>>;

	beforeEach(async () => {
		identity = prepareOfflineIdentity();
		const db = getOfflineDB(identity);
		await Promise.all([
			db.documents.clear(),
			db.folders.clear(),
			db.drafts.clear(),
			db.metadata.clear(),
		]);

		// Fresh caches + service worker mocks for every test.
		deleteMock = mock<(name: string) => Promise<boolean>>(() =>
			Promise.resolve(true),
		);
		postMessage = mock<(msg: unknown) => void>(() => {});
		Object.defineProperty(globalThis, "caches", {
			configurable: true,
			value: {
				keys: mock(() =>
					Promise.resolve([
						"hiai-docs::hiai-docs-pwa-local::pwa-v1::pages",
						"hiai-docs::hiai-docs-pwa-local::pwa-v1::static",
						"unrelated",
					]),
				),
				delete: deleteMock,
			},
		});
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: {
				serviceWorker: {
					getRegistration: mock(() =>
						Promise.resolve({ active: { postMessage } }),
					),
				},
			},
		});
	});

	it("clears every Dexie table", async () => {
		const db = getOfflineDB(identity);
		await db.documents.put({
			id: "d1",
			ownerId: identity.ownerId,
			title: "t",
			folderId: null,
			updatedAt: "u",
			cachedAt: 1,
		});
		await db.drafts.put({
			docId: "d1",
			ownerId: identity.ownerId,
			patch: { title: "x" },
			expectedUpdatedAt: "u",
			updatedAt: 1,
		});
		await db.metadata.put({ key: "lastSync", value: 1 });

		await cleanupOfflineData();

		const freshDb = getOfflineDB(identity);
		expect(await freshDb.documents.toArray()).toHaveLength(0);
		expect(await freshDb.folders.toArray()).toHaveLength(0);
		expect(await freshDb.drafts.toArray()).toHaveLength(0);
		expect(await freshDb.metadata.toArray()).toHaveLength(0);
	});

	it("deletes only the Workbox-matching caches", async () => {
		await cleanupOfflineData();
		expect(deleteMock).toHaveBeenCalledWith(
			"hiai-docs::hiai-docs-pwa-local::pwa-v1::pages",
		);
		expect(deleteMock).toHaveBeenCalledWith(
			"hiai-docs::hiai-docs-pwa-local::pwa-v1::static",
		);
		expect(deleteMock).not.toHaveBeenCalledWith("unrelated");
	});

	it("deletes Workbox precache names as well as runtime cache names", async () => {
		const precacheName =
			"hiai-docs::hiai-docs-pwa-local::pwa-v1-precache-v2-http://localhost/";
		Object.defineProperty(globalThis, "caches", {
			configurable: true,
			value: {
				keys: mock(() => Promise.resolve([precacheName, "unrelated"])),
				delete: deleteMock,
			},
		});

		await cleanupOfflineData();
		expect(deleteMock).toHaveBeenCalledWith(precacheName);
		expect(deleteMock).not.toHaveBeenCalledWith("unrelated");
	});

	it("notifies the service worker with a scoped cache-clear message", async () => {
		await cleanupOfflineData();
		expect(postMessage).toHaveBeenCalledWith({
			type: "CLEAR_HOST_CACHES",
			cachePrefix: "hiai-docs::hiai-docs-pwa-local::pwa-v1",
		});
	});

	it("does not throw when no service worker is present", async () => {
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: {},
		});
		await expect(cleanupOfflineData()).resolves.toBeUndefined();
	});

	it("does not wait for the service worker ready promise", async () => {
		const getRegistration = mock(() => Promise.resolve(undefined));
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: {
				serviceWorker: {
					ready: new Promise(() => {}),
					getRegistration,
				},
			},
		});

		await expect(cleanupOfflineData()).resolves.toBeUndefined();
		expect(getRegistration).toHaveBeenCalledWith("/");
	});
});
