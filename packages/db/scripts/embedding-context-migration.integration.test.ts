import { describe, expect, it } from "bun:test";
import postgres from "postgres";
import { requireIntegrationUrl } from "./integration-env";

const databaseUrl = requireIntegrationUrl("PIPELINE_RLS_TEST_DATABASE_URL");

describe("embedding context migration integration", () => {
	it("preserves legacy null context and defaults pipeline refreshes to full", async () => {
		const sql = postgres(databaseUrl, { max: 1 });
		const ownerId = crypto.randomUUID();
		const documentId = crypto.randomUUID();
		const generationId = crypto.randomUUID();
		try {
			const columns = await sql`
				SELECT table_name, column_name, is_nullable, column_default
				FROM information_schema.columns
				WHERE table_schema = 'public'
					AND (table_name, column_name) IN (
						('documents', 'embedding_context_hash'),
						('document_pipeline_runs', 'embedding_context_hash'),
						('document_pipeline_runs', 'refresh_mode')
					)
				ORDER BY table_name, column_name`;
			expect(columns).toEqual([
				expect.objectContaining({
					table_name: "document_pipeline_runs",
					column_name: "embedding_context_hash",
					is_nullable: "YES",
				}),
				expect.objectContaining({
					table_name: "document_pipeline_runs",
					column_name: "refresh_mode",
					is_nullable: "NO",
					column_default: "'full'::text",
				}),
				expect.objectContaining({
					table_name: "documents",
					column_name: "embedding_context_hash",
					is_nullable: "YES",
				}),
			]);

			await sql
				.begin(async (tx) => {
					await tx`INSERT INTO public.users (id, email)
						VALUES (${ownerId}::uuid, ${`${ownerId}@embedding-context.invalid`})`;
					await tx`INSERT INTO public.documents (id, owner_id, title, content)
						VALUES (${documentId}::uuid, ${ownerId}::uuid, 'legacy-context', '')`;
					await tx`INSERT INTO public.document_pipeline_runs
						(document_id, owner_id, generation_id, revision, source)
						VALUES (${documentId}::uuid, ${ownerId}::uuid, ${generationId}::uuid, 'legacy', 'migration-test')`;
					const [document] = await tx`SELECT embedding_context_hash
						FROM public.documents WHERE id = ${documentId}::uuid`;
					const [run] = await tx`SELECT embedding_context_hash, refresh_mode
						FROM public.document_pipeline_runs
						WHERE document_id = ${documentId}::uuid AND generation_id = ${generationId}::uuid`;
					expect(document?.embedding_context_hash).toBeNull();
					expect(run).toMatchObject({
						embedding_context_hash: null,
						refresh_mode: "full",
					});

					let invalidModeRejected = false;
					await tx
						.savepoint(async (savepoint) => {
							await savepoint`UPDATE public.document_pipeline_runs
								SET refresh_mode = 'partial'
								WHERE document_id = ${documentId}::uuid`;
						})
						.catch(() => {
							invalidModeRejected = true;
						});
					expect(invalidModeRejected).toBe(true);
					throw new Error("ROLLBACK_EMBEDDING_CONTEXT_MIGRATION_TEST");
				})
				.catch((error: Error) => {
					if (error.message !== "ROLLBACK_EMBEDDING_CONTEXT_MIGRATION_TEST") {
						throw error;
					}
				});
		} finally {
			await sql.end();
		}
	});
});
