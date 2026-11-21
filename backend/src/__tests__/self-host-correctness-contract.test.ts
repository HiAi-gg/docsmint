import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { analyzeQuery } from "../search/query-analyzer";
import { retrieveFastChannels } from "../search/retrievers";

describe("self-host correctness contracts", () => {
	test("filters trash before every retrieval channel", async () => {
		const userId = "00000000-0000-4000-8000-000000000001";
		const categoryId = "00000000-0000-4000-8000-000000000002";
		const documentId = "00000000-0000-4000-8000-000000000003";
		const dialect = new PgDialect();
		for (const restricted of [false, true]) {
			const queries: string[] = [];
			const scope = restricted
				? {
						source: "external" as const,
						workspaceId: "workspace-a",
						resourceScope: {
							kind: "category" as const,
							categoryId,
							permissions: ["read" as const],
						},
					}
				: {};
			await retrieveFastChannels(
				{ userId, role: "user", ...scope },
				analyzeQuery("search"),
				{
					...(restricted ? { categoryId, documentIds: [documentId] } : {}),
					queryEmbedding: {
						ok: true,
						profile: "test",
						model: "test",
						provider: "primary",
						dimensions: 1024,
						vector: Array.from({ length: 1024 }, () => 0.1),
					},
					execute: async (_channel, _context, query) => {
						queries.push(
							dialect.sqlToQuery(
								query as Parameters<PgDialect["sqlToQuery"]>[0],
							).sql,
						);
						return [];
					},
				},
			);
			expect(queries).toHaveLength(4);
			for (const query of queries) {
				expect(query).toContain("d.deleted_at IS NULL");
				expect(query.indexOf("d.deleted_at IS NULL")).toBeLessThan(
					query.lastIndexOf("LIMIT"),
				);
			}
		}
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
