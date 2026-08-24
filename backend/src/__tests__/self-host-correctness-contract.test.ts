import { describe, expect, test } from "bun:test";

describe("self-host correctness contracts", () => {
	test("filters trash before every retrieval channel", async () => {
		const retrievers = await Bun.file(
			new URL("../search/retrievers.ts", import.meta.url),
		).text();
		expect(retrievers.match(/d\.deleted_at IS NULL/g)).toHaveLength(5);
	});

	test("never falls graph extraction back to embedding endpoints", async () => {
		const extraction = await Bun.file(
			new URL("../lib/graph/extract-entities.ts", import.meta.url),
		).text();
		expect(extraction).not.toContain("config.EMBEDDING_BASE_URL");
		expect(extraction).not.toContain("config.EMBEDDING_FALLBACK_BASE_URL");
	});

	test("refreshes folder metadata after moves as well as renames", async () => {
		const folders = await Bun.file(
			new URL("../api/routes/folders.ts", import.meta.url),
		).text();
		expect(folders).toContain("parsed.data.parentId !== undefined ||");
		expect(folders).toContain("parsed.data.categoryId !== undefined");
		expect(folders).toContain("? await snapshotMetadataImpact(tx, ctx, {");
		expect(folders).toContain('kind: "folder"');
		expect(folders).toContain("dispatchMetadataReembedOutbox(");
	});
});
