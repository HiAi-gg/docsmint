import { describe, expect, test } from "bun:test";

const routeFiles = [
	"attachments.ts",
	"documents.ts",
	"folders.ts",
	"graph.ts",
	"search.ts",
	"share.ts",
	"tags.ts",
	"versions.ts",
	"visibility.ts",
] as const;

describe("Trash route contract", () => {
	test("declares the trash lifecycle endpoints", async () => {
		const source = await Bun.file(
			new URL("../api/routes/documents.ts", import.meta.url),
		).text();
		expect(source).toContain('.get("/trash"');
		expect(source).toContain('.post("/trash/documents/:id/restore"');
		expect(source).toContain('.delete("/trash/documents/:id"');
	});

	test("all content surfaces explicitly exclude soft-deleted documents", async () => {
		for (const file of routeFiles) {
			const source = await Bun.file(
				new URL(`../api/routes/${file}`, import.meta.url),
			).text();
			expect(source, file).toContain("isNull(documents.deletedAt)");
		}
	});

	test("migration and retention configuration remain OSS-owned", async () => {
		const migration = await Bun.file(
			new URL(
				"../../../packages/db/src/migrations/0039_document_trash.sql",
				import.meta.url,
			),
		).text();
		const config = await Bun.file(
			new URL("../lib/config-schema.ts", import.meta.url),
		).text();
		expect(migration).toContain('"deleted_at"');
		expect(migration).toContain('"documents_workspace_deleted_at_idx"');
		expect(config).toContain("DOCUMENT_TRASH_RETENTION_DAYS");
	});
});
