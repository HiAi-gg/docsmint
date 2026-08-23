import { expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { resolveFolderEffectiveCategory } from "../lib/content-access";

const databaseUrl = process.env.CONTENT_ACCESS_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)(
	"recursive folder category resolution executes on PostgreSQL",
	async () => {
		const client = postgres(databaseUrl as string, { max: 1 });
		const dialect = new PgDialect();
		const ownerId = crypto.randomUUID();
		const categoryId = crypto.randomUUID();
		const parentId = crypto.randomUUID();
		const childId = crypto.randomUUID();
		try {
			await client.begin(async (tx) => {
				await tx`CREATE TEMP TABLE folders (id uuid PRIMARY KEY, owner_id uuid NOT NULL, workspace_id text, parent_id uuid, category_id uuid) ON COMMIT DROP`;
				await tx`SET LOCAL search_path TO pg_temp`;
				await tx`INSERT INTO folders (id, owner_id, parent_id, category_id) VALUES (${parentId}::uuid, ${ownerId}::uuid, NULL, ${categoryId}::uuid), (${childId}::uuid, ${ownerId}::uuid, ${parentId}::uuid, NULL)`;
				const executor = {
					execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
						const rendered = dialect.sqlToQuery(query);
						return tx.unsafe(rendered.sql, rendered.params as never[]);
					},
				};
				await expect(
					resolveFolderEffectiveCategory(
						executor,
						{
							userId: ownerId,
							source: "personal",
							role: "user",
						},
						childId,
					),
				).resolves.toBe(categoryId);
			});
		} finally {
			await client.end();
		}
	},
);

test.skipIf(!databaseUrl)(
	"occupied replay keys distinguish authorized replay from a non-disclosing conflict",
	async () => {
		const client = postgres(databaseUrl as string, { max: 1 });
		try {
			await client.begin(async (tx) => {
				await tx`CREATE TEMP TABLE replay_documents (id uuid PRIMARY KEY, category_id uuid, deleted_at timestamptz) ON COMMIT DROP`;
				await tx`CREATE TEMP TABLE replay_operations (workspace_id text, actor_user_id uuid, idempotency_key text, document_id uuid REFERENCES replay_documents(id), UNIQUE(workspace_id, actor_user_id, idempotency_key)) ON COMMIT DROP`;
				const actorId = crypto.randomUUID();
				const allowedCategory = crypto.randomUUID();
				const deniedCategory = crypto.randomUUID();
				const allowedDocument = crypto.randomUUID();
				const deniedDocument = crypto.randomUUID();
				await tx`INSERT INTO replay_documents VALUES (${allowedDocument}::uuid, ${allowedCategory}::uuid, NULL), (${deniedDocument}::uuid, ${deniedCategory}::uuid, NULL)`;
				await tx`INSERT INTO replay_operations VALUES ('workspace', ${actorId}::uuid, 'allowed-key', ${allowedDocument}::uuid), ('workspace', ${actorId}::uuid, 'occupied-key', ${deniedDocument}::uuid)`;
				const lookup = (key: string) =>
					tx`SELECT d.id, (d.deleted_at IS NULL AND d.category_id = ${allowedCategory}::uuid) AS authorized FROM replay_operations o JOIN replay_documents d ON d.id = o.document_id WHERE o.workspace_id = 'workspace' AND o.actor_user_id = ${actorId}::uuid AND o.idempotency_key = ${key}`;
				const [allowed] = await lookup("allowed-key");
				const [occupied] = await lookup("occupied-key");
				expect(allowed?.authorized).toBe(true);
				expect(occupied?.authorized).toBe(false);
				expect(occupied?.id).toBe(deniedDocument);
			});
		} finally {
			await client.end();
		}
	},
);
