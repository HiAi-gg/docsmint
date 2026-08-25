import { describe, expect, it } from "bun:test";
import postgres from "postgres";
import { requireIntegrationUrl } from "./integration-env";

const ownerUrl = requireIntegrationUrl("PIPELINE_RLS_TEST_DATABASE_URL");

describe("workspace document-child RLS integration", () => {
	it("admits same-workspace cross-owner children and excludes personal and foreign tenants as hiai_app", async () => {
		const sql = postgres(ownerUrl, { max: 1 });
		const actorA = crypto.randomUUID();
		const actorB = crypto.randomUUID();
		const workspaceA = `child-rls-a-${crypto.randomUUID()}`;
		const workspaceB = `child-rls-b-${crypto.randomUUID()}`;
		const docs = {
			actorWorkspace: crypto.randomUUID(),
			peerWorkspace: crypto.randomUUID(),
			foreignWorkspace: crypto.randomUUID(),
			actorPersonal: crypto.randomUUID(),
			peerPersonal: crypto.randomUUID(),
		};
		const tags = {
			workspace: crypto.randomUUID(),
			foreign: crypto.randomUUID(),
			personal: crypto.randomUUID(),
		};
		const generation = crypto.randomUUID();

		try {
			await sql
				.begin(async (tx) => {
					await tx`SELECT set_config('app.current_user_role', 'admin', true)`;
					await tx`INSERT INTO public.users (id, email) VALUES
						(${actorA}::uuid, ${`${actorA}@child-rls.invalid`}),
						(${actorB}::uuid, ${`${actorB}@child-rls.invalid`})`;
					await tx`INSERT INTO public.documents
						(id, owner_id, workspace_id, title, content) VALUES
						(${docs.actorWorkspace}::uuid, ${actorA}::uuid, ${workspaceA}, 'actor workspace', ''),
						(${docs.peerWorkspace}::uuid, ${actorB}::uuid, ${workspaceA}, 'peer workspace', ''),
						(${docs.foreignWorkspace}::uuid, ${actorB}::uuid, ${workspaceB}, 'foreign workspace', ''),
						(${docs.actorPersonal}::uuid, ${actorA}::uuid, NULL, 'actor personal', ''),
						(${docs.peerPersonal}::uuid, ${actorB}::uuid, NULL, 'peer personal', '')`;
					await tx`INSERT INTO public.tags (id, owner_id, workspace_id, name) VALUES
						(${tags.workspace}::uuid, ${actorB}::uuid, ${workspaceA}, 'workspace'),
						(${tags.foreign}::uuid, ${actorB}::uuid, ${workspaceB}, 'foreign'),
						(${tags.personal}::uuid, ${actorA}::uuid, NULL, 'personal')`;
					for (const [documentId, ownerId, workspaceId, tagId] of [
						[docs.actorWorkspace, actorA, workspaceA, tags.workspace],
						[docs.peerWorkspace, actorB, workspaceA, tags.workspace],
						[docs.foreignWorkspace, actorB, workspaceB, tags.foreign],
						[docs.actorPersonal, actorA, null, tags.personal],
						[docs.peerPersonal, actorB, null, tags.personal],
					] as const) {
						await tx`INSERT INTO public.document_tags (workspace_id, document_id, tag_id)
							VALUES (${workspaceId}, ${documentId}::uuid, ${tagId}::uuid)`;
						await tx`INSERT INTO public.attachments
							(document_id, workspace_id, uploaded_by, filename, mime_type, size, storage_key)
							VALUES (${documentId}::uuid, ${workspaceId}, ${ownerId}::uuid, 'fixture.txt', 'text/plain', 1, ${`${documentId}/fixture.txt`})`;
						await tx`INSERT INTO public.versions
							(document_id, workspace_id, content, created_by)
							VALUES (${documentId}::uuid, ${workspaceId}, 'fixture', ${ownerId}::uuid)`;
						await tx`INSERT INTO public.document_embeddings
							(document_id, workspace_id, chunk_index, chunk_text, generation_id, embedding_model, embedding_dimensions, embedding_profile, is_valid)
							VALUES (${documentId}::uuid, ${workspaceId}, 0, 'fixture', gen_random_uuid(), 'fixture', 1024, 'fixture', false)`;
					}

					await tx.unsafe("SET LOCAL ROLE hiai_app");
					await tx`SELECT set_config('app.current_user_id', ${actorA}, true)`;
					await tx`SELECT set_config('app.current_user_role', 'user', true)`;
					await tx`SELECT set_config('app.current_workspace_id', ${workspaceA}, true)`;
					for (const table of [
						"document_tags",
						"attachments",
						"versions",
						"document_embeddings",
					] as const) {
						const rows = await tx.unsafe(
							`SELECT document_id::text AS document_id FROM public.${table} ORDER BY document_id`,
						);
						const visible = rows.map((row) => row.document_id);
						expect(visible, table).toContain(docs.actorWorkspace);
						expect(visible, table).toContain(docs.peerWorkspace);
						// The generic parent policy also admits the actor's own personal
						// rows while a workspace GUC is set. It must never admit a peer's
						// personal row or a foreign workspace row.
						expect(visible, table).toContain(docs.actorPersonal);
						expect(visible, table).not.toContain(docs.peerPersonal);
						expect(visible, table).not.toContain(docs.foreignWorkspace);
					}

					await tx`SELECT set_config('app.current_workspace_id', '', true)`;
					for (const table of ["attachments", "versions"] as const) {
						const personalRows = await tx.unsafe(
							`SELECT document_id::text AS document_id FROM public.${table} ORDER BY document_id`,
						);
						expect(personalRows.map((row) => row.document_id), table).toEqual([
							docs.actorPersonal,
						]);
					}

					await tx`INSERT INTO public.document_pipeline_runs
						(document_id, owner_id, generation_id, revision, source)
						VALUES (${docs.actorPersonal}::uuid, ${actorA}::uuid, ${generation}::uuid, 'personal', 'rls-test')`;
					await tx`INSERT INTO public.document_pipeline_batches
						(document_id, generation_id, batch_index, chunk_start, chunk_end)
						VALUES (${docs.actorPersonal}::uuid, ${generation}::uuid, 0, 0, 1)`;
					const batchRows = await tx`SELECT document_id::text AS document_id
						FROM public.document_pipeline_batches
						WHERE generation_id = ${generation}::uuid`;
					expect(batchRows.map((row) => row.document_id)).toEqual([
						docs.actorPersonal,
					]);

					const forced = await tx`SELECT relname, relforcerowsecurity
						FROM pg_class
						WHERE relname IN ('document_tags', 'attachments', 'versions', 'document_embeddings')
						ORDER BY relname`;
					expect(forced).toHaveLength(4);
					expect(forced.every((row) => row.relforcerowsecurity === true)).toBe(
						true,
					);

					await tx.unsafe("RESET ROLE");
					throw new Error("ROLLBACK_WORKSPACE_CHILD_RLS_TEST");
				})
				.catch((error: Error) => {
					if (error.message !== "ROLLBACK_WORKSPACE_CHILD_RLS_TEST") throw error;
				});
		} finally {
			await sql.end();
		}
	});
});
