import { beforeEach, describe, expect, it } from "bun:test";
import type { Document } from "#lib/api/documents.js";
import { cacheDocument } from "#lib/db/documents.js";
import { getOfflineDB } from "#lib/db/index.js";
import type { OfflineIdentity } from "#lib/offline/identity.js";
import { offlineSearch } from "#lib/offline/offline-search.js";
import { prepareOfflineIdentity } from "./test-identity";

function makeDocument(id: string, title: string, content: string): Document {
	return {
		id,
		title,
		content,
		folderId: null,
		folderName: "",
		categoryId: null,
		tags: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		excerpt: "",
	};
}

describe("offlineSearch (offline/offline-search.ts)", () => {
	let identity: OfflineIdentity;

	beforeEach(async () => {
		identity = prepareOfflineIdentity();
		const db = getOfflineDB(identity);
		await db.documents.clear();
	});

	it("matches documents by title", async () => {
		await cacheDocument(
			makeDocument("a", "Quarterly Report", "boring numbers"),
			identity,
		);
		await cacheDocument(
			makeDocument("b", "Grocery List", "milk and eggs"),
			identity,
		);
		const results = await offlineSearch("Report", identity);
		expect(results.map((r) => r.id)).toEqual(["a"]);
	});

	it("matches documents by content", async () => {
		await cacheDocument(
			makeDocument("a", "Doc A", "the quick brown fox"),
			identity,
		);
		await cacheDocument(makeDocument("b", "Doc B", "nothing here"), identity);
		const results = await offlineSearch("brown", identity);
		expect(results.map((r) => r.id)).toEqual(["a"]);
	});

	it("is case-insensitive", async () => {
		await cacheDocument(
			makeDocument("a", "UPPERCASE TITLE", "SOME CONTENT"),
			identity,
		);
		const byLower = await offlineSearch("uppercase title", identity);
		const byUpper = await offlineSearch("UPPERCASE TITLE", identity);
		expect(byLower).toHaveLength(1);
		expect(byUpper).toHaveLength(1);
		const byContent = await offlineSearch("some content", identity);
		expect(byContent).toHaveLength(1);
	});

	it("returns at most 20 results", async () => {
		for (let i = 0; i < 25; i++) {
			await cacheDocument(
				makeDocument(`d${i}`, `Match ${i}`, "shared keyword"),
				identity,
			);
		}
		const results = await offlineSearch("shared", identity);
		expect(results).toHaveLength(20);
	});

	it("returns an empty array when nothing matches", async () => {
		await cacheDocument(makeDocument("a", "Something", "else"), identity);
		expect(await offlineSearch("zzz-no-match", identity)).toEqual([]);
	});
});
