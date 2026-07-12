import { describe, expect, it } from "bun:test";
import postgres from "postgres";

const ownerUrl = process.env.PIPELINE_RLS_TEST_DATABASE_URL;
const integrationIt = ownerUrl ? it : it.skip;

describe("pipeline tenant RLS integration", () => {
	integrationIt(
		"denies cross-owner runs and batches while preserving admin access",
		async () => {
			const sql = postgres(ownerUrl as string, { max: 1 });
			const ownerA = crypto.randomUUID();
			const ownerB = crypto.randomUUID();
			const documentA = crypto.randomUUID();
			const documentB = crypto.randomUUID();
			const generationA = crypto.randomUUID();
			const generationB = crypto.randomUUID();

			try {
				await sql
					.begin(async (tx) => {
						await tx`SELECT set_config('app.current_user_id', ${ownerA}, true)`;
						await tx`SELECT set_config('app.current_user_role', 'admin', true)`;
						await tx`INSERT INTO public.users (id, email) VALUES
					(${ownerA}::uuid, ${`${ownerA}@rls.invalid`}),
					(${ownerB}::uuid, ${`${ownerB}@rls.invalid`})`;
						await tx`INSERT INTO public.documents (id, owner_id, title, content) VALUES
					(${documentA}::uuid, ${ownerA}::uuid, 'owner-a', '{}'),
					(${documentB}::uuid, ${ownerB}::uuid, 'owner-b', '{}')`;
						await tx`INSERT INTO public.document_pipeline_runs
					(document_id, owner_id, generation_id, revision, source)
					VALUES
					(${documentA}::uuid, ${ownerA}::uuid, ${generationA}::uuid, 'a', 'rls-test'),
					(${documentB}::uuid, ${ownerB}::uuid, ${generationB}::uuid, 'b', 'rls-test')`;
						await tx`INSERT INTO public.document_pipeline_batches
					(document_id, generation_id, batch_index, chunk_start, chunk_end)
					VALUES
					(${documentA}::uuid, ${generationA}::uuid, 0, 0, 1),
					(${documentB}::uuid, ${generationB}::uuid, 0, 0, 1)`;

						await tx.unsafe("SET LOCAL ROLE hiai_app");
						await tx`SELECT set_config('app.current_user_id', ${ownerA}, true)`;
						await tx`SELECT set_config('app.current_user_role', 'user', true)`;
						const userRuns =
							await tx`SELECT owner_id FROM public.document_pipeline_runs`;
						const userBatches =
							await tx`SELECT document_id FROM public.document_pipeline_batches`;
						expect(userRuns.map((row) => row.owner_id)).toEqual([ownerA]);
						expect(userBatches.map((row) => row.document_id)).toEqual([
							documentA,
						]);

						await tx`SELECT set_config('app.current_user_role', 'admin', true)`;
						const adminRuns =
							await tx`SELECT owner_id FROM public.document_pipeline_runs ORDER BY owner_id`;
						expect(adminRuns).toHaveLength(2);

						await tx.unsafe("RESET ROLE");
						throw new Error("ROLLBACK_PIPELINE_RLS_TEST");
					})
					.catch((error: Error) => {
						if (error.message !== "ROLLBACK_PIPELINE_RLS_TEST") throw error;
					});
			} finally {
				await sql.end();
			}
		},
	);
});
