import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { graphSearchDocumentQuery } from "../lib/graph/search-query";

const ctx = {
	userId: "11111111-1111-4111-8111-111111111111",
	role: "user" as const,
	source: "personal" as const,
};
const dialect = new PgDialect();
const databaseUrl = process.env.CONTENT_ACCESS_TEST_DATABASE_URL;

describe("graph neighbor lexical selection", () => {
	test("binds user queries and constrains selection to authorized non-deleted tenant neighbors", () => {
		const rendered = dialect.sqlToQuery(
			graphSearchDocumentQuery(ctx, ["allowed"], "cats ' OR true --"),
		);
		expect(rendered.sql).toContain("deleted_at IS NULL");
		expect(rendered.sql).toContain("d.owner_id");
		expect(rendered.sql).toContain("d.id IN");
		expect(rendered.sql).not.toContain("cats ' OR true --");
		expect(rendered.params).toContain("allowed");
		expect(rendered.params).toContain("cats ' OR true --");
	});
	test.skipIf(!databaseUrl)(
		"query changes the matching graph neighbors and ranks exact titles first",
		async () => {
			const client = postgres(databaseUrl as string, { max: 1 });
			try {
				await client.begin(async (tx) => {
					await tx`CREATE TEMP TABLE documents (id text, owner_id uuid, workspace_id text, title text, content text, deleted_at timestamptz, search_vector tsvector, search_vector_simple tsvector) ON COMMIT DROP`;
					await tx`SET LOCAL search_path TO pg_temp`;
					const rows = [
						["a", "Platform", "cat care and cats", ctx.userId, null],
						["b", "Cats", "feline notes", ctx.userId, null],
						["c", "Dogs", "dog care", ctx.userId, null],
						[
							"foreign",
							"Cats",
							"cats",
							"22222222-2222-4222-8222-222222222222",
							null,
						],
						["deleted", "Cats", "cats", ctx.userId, new Date()],
						["unlisted", "Cats", "cats", ctx.userId, null],
					] as const;
					for (const [id, title, content, owner, deleted] of rows) {
						await tx`INSERT INTO documents VALUES (${id}, ${owner}::uuid, NULL, ${title}, ${content}, ${deleted}, to_tsvector('english', ${`${title} ${content}`}), to_tsvector('simple', ${`${title} ${content}`}))`;
					}
					async function search(query?: string) {
						const rendered = dialect.sqlToQuery(
							graphSearchDocumentQuery(
								ctx,
								["a", "b", "c", "foreign", "deleted"],
								query,
							),
						);
						const result = await tx.unsafe(
							rendered.sql,
							rendered.params as never[],
						);
						return result.map((row) => row.id);
					}
					expect(await search("cats")).toEqual(["b", "a"]);
					expect(await search("dogs")).toEqual(["c"]);
					expect(await search("absentterm")).toEqual([]);
					expect(await search(" ")).toEqual(["a", "b", "c"]);
				});
			} finally {
				await client.end();
			}
		},
	);
});
