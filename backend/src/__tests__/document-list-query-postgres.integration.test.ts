import { expect, test } from "bun:test";
import { documents } from "@hiai-docs/db/schema";
import { and, isNull, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { tenantOwnerCondition } from "../lib/content-access";
import {
	documentListConditions,
	documentListOrder,
	documentListQuerySchema,
} from "../lib/document-list-query";

const databaseUrl = process.env.CONTENT_ACCESS_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)(
	"document list filters execute with inherited categories and scoped totals on PostgreSQL",
	async () => {
		const client = postgres(databaseUrl as string, { max: 1 });
		const dialect = new PgDialect();
		const owner = crypto.randomUUID(),
			foreign = crypto.randomUUID(),
			category = crypto.randomUUID();
		const parent = crypto.randomUUID(),
			child = crypto.randomUUID(),
			tagA = crypto.randomUUID(),
			tagB = crypto.randomUUID();
		const ids = Array.from({ length: 4 }, () => crypto.randomUUID()).sort();
		const firstId = ids[0],
			secondId = ids[1];
		if (!firstId || !secondId) throw new Error("Invalid generated fixture IDs");
		const ctx = {
			userId: owner,
			role: "user" as const,
			source: "personal" as const,
		};
		const rollback = new Error("ROLLBACK_DOCUMENT_LIST_FILTER_TEST");
		try {
			await client
				.begin(async (tx) => {
					await tx`CREATE TEMP TABLE documents (id uuid PRIMARY KEY, owner_id uuid NOT NULL, workspace_id text, folder_id uuid, category_id uuid, title text, content text, updated_at timestamp, created_at timestamp, deleted_at timestamp) ON COMMIT DROP`;
					await tx`CREATE TEMP TABLE folders (id uuid PRIMARY KEY, parent_id uuid, owner_id uuid, workspace_id text, category_id uuid) ON COMMIT DROP`;
					await tx`CREATE TEMP TABLE tags (id uuid PRIMARY KEY, owner_id uuid, workspace_id text) ON COMMIT DROP`;
					await tx`CREATE TEMP TABLE document_tags (document_id uuid, tag_id uuid) ON COMMIT DROP`;
					await tx`SET LOCAL search_path TO pg_temp`;
					await tx`INSERT INTO folders VALUES (${parent}::uuid, NULL, ${owner}::uuid, NULL, ${category}::uuid), (${child}::uuid, ${parent}::uuid, ${owner}::uuid, NULL, NULL)`;
					await tx`INSERT INTO tags VALUES (${tagA}::uuid, ${owner}::uuid, NULL), (${tagB}::uuid, ${owner}::uuid, NULL)`;
					for (let i = 0; i < ids.length; i++) {
						const id = ids[i];
						if (!id) throw new Error("Missing fixture ID");
						await tx`INSERT INTO documents VALUES (${id}::uuid, ${i === 3 ? foreign : owner}::uuid, NULL, ${i === 0 || i === 3 ? child : null}::uuid, NULL, ${`Doc ${i}`}, ${i === 0 ? `literal %_ and ${"😀".repeat(201)}` : "other text"}, '2026-01-02T00:00:00', '2026-01-01T00:00:00', NULL)`;
					}
					await tx`INSERT INTO document_tags VALUES (${firstId}::uuid, ${tagA}::uuid), (${firstId}::uuid, ${tagB}::uuid), (${secondId}::uuid, ${tagA}::uuid)`;
					async function list(input: Record<string, unknown>) {
						const query = documentListQuerySchema.parse(input);
						const conditions = and(
							tenantOwnerCondition(
								documents.ownerId,
								documents.workspaceId,
								ctx,
							),
							isNull(documents.deletedAt),
							...documentListConditions(ctx, query),
						);
						const countQuery = dialect.sqlToQuery(
							sql`SELECT count(*)::integer AS total FROM ${documents} WHERE ${conditions}`,
						);
						const [count] = await tx.unsafe(
							countQuery.sql,
							countQuery.params as never[],
						);
						const rendered = dialect.sqlToQuery(
							sql`SELECT ${documents.id} AS id, LEFT(${documents.content}, 200) AS preview FROM ${documents} WHERE ${conditions} ORDER BY ${sql.join(documentListOrder(query), sql`, `)} LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`,
						);
						return {
							total: count?.total,
							rows: await tx.unsafe(rendered.sql, rendered.params as never[]),
						};
					}
					const inherited = await list({ categoryId: category });
					expect(inherited.total).toBe(1);
					expect(inherited.rows.map((row) => row.id)).toEqual([ids[0]]);
					expect(Array.from(inherited.rows[0]?.preview as string)).toHaveLength(
						200,
					);
					expect((await list({ q: "%_" })).rows.map((row) => row.id)).toEqual([
						ids[0],
					]);
					expect((await list({ rootOnly: "true" })).total).toBe(2);
					expect((await list({ tagIds: `${tagA},${tagB}` })).total).toBe(1);
					expect(
						(await list({ tagIds: `${tagA},${tagB}`, tagMatch: "any" })).total,
					).toBe(2);
					expect(
						(
							await list({
								updatedFrom: "2026-01-02T00:00:00Z",
								updatedTo: "2026-01-03T00:00:00Z",
							})
						).total,
					).toBe(3);
					expect(
						(await list({ updatedTo: "2026-01-02T00:00:00Z" })).total,
					).toBe(0);
					const first = await list({ limit: 1 }),
						second = await list({ limit: 1, page: 2 });
					expect(first.total).toBe(3);
					expect(first.rows[0]?.id).toBe(ids[2]);
					expect(second.rows[0]?.id).toBe(ids[1]);
					throw rollback;
				})
				.catch((error: unknown) => {
					if (error !== rollback) throw error;
				});
		} finally {
			await client.end();
		}
	},
	20_000,
);
