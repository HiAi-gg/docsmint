import { describe, expect, it } from "bun:test";

const migrationFiles = [
	"0012_create_hiai_app_role.sql",
	"0021_initialize_graphrag.sql",
	"0022_grant_age_catalog_read.sql",
] as const;

describe("migration-owner SQL portability", () => {
	for (const filename of migrationFiles) {
		it(`${filename} grants defaults for the active migration owner`, async () => {
			const sql = await Bun.file(
				new URL(`../src/migrations/${filename}`, import.meta.url),
			).text();
			expect(sql).not.toMatch(/ALTER DEFAULT PRIVILEGES FOR ROLE aiuser\b/i);
			expect(sql).toMatch(
				/ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA/i,
			);
		});
	}

	it("keeps GraphRAG and AGE grants assigned to hiai_app", async () => {
		const graphSql = await Bun.file(
			new URL(
				"../src/migrations/0021_initialize_graphrag.sql",
				import.meta.url,
			),
		).text();
		const ageSql = await Bun.file(
			new URL(
				"../src/migrations/0022_grant_age_catalog_read.sql",
				import.meta.url,
			),
		).text();
		expect(graphSql).toContain("TO hiai_app");
		expect(ageSql).toContain("TO hiai_app");
	});
});
