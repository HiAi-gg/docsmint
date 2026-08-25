import { describe, expect, test } from "bun:test";
import { createDatabaseClient } from "@hiai-docs/db/client";
import { withTenantDatabase } from "@hiai-docs/db/with-tenant";
import { Elysia } from "elysia";
import postgres from "postgres";
import { authRoutes } from "../api/routes/auth";
import { drainAttachmentStorageCleanupOutbox } from "../lib/attachment-storage-cleanup";
import { createPersistentLifecycleService } from "../lib/lifecycle-service";
import { createAccountPipelineCancellation } from "../queue/account-pipeline-cancellation";

const ownerDatabaseUrl = Bun.env.CONTENT_ACCESS_TEST_DATABASE_URL?.trim();
const runtimeDatabaseUrl = Bun.env.DATABASE_URL?.trim();
const redisUrl = Bun.env.REDIS_URL?.trim();

type Deferred<T> = Readonly<{
	promise: Promise<T>;
	resolve: (value: T) => void;
}>;

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function subjectHash(userId: string): string {
	return new Bun.CryptoHasher("sha256").update(userId).digest("hex");
}

async function withRuntimeTenant(
	client: postgres.Sql,
	actorUserId: string,
	workspaceId: string | null,
	operation: (tx: postgres.TransactionSql) => Promise<unknown>,
	role: "user" | "admin" = "user",
): Promise<void> {
	await client.begin(async (tx) => {
		await tx`SELECT set_config('app.current_user_id', ${actorUserId}, true)`;
		await tx`SELECT set_config('app.current_user_role', ${role}, true)`;
		await tx`SELECT set_config('app.current_workspace_id', ${workspaceId ?? ""}, true)`;
		await operation(tx);
	});
}

function expectFence(error: unknown): void {
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).message).toContain("account_purge_fenced");
}

describe.skipIf(!ownerDatabaseUrl || !runtimeDatabaseUrl)(
	"account purge hardening PostgreSQL contract",
	() => {
		test("a completed personal purge fences stale workspace actors without freezing peer-owned tenant rows", async () => {
			const setup = postgres(ownerDatabaseUrl as string, { max: 1 });
			const runtime = postgres(runtimeDatabaseUrl as string, { max: 2 });
			const ownerA = crypto.randomUUID();
			const ownerB = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const folderId = crypto.randomUUID();
			const categoryId = crypto.randomUUID();
			const tagId = crypto.randomUUID();
			const workspaceId = `workspace-${crypto.randomUUID()}`;
			try {
				await setup`INSERT INTO public.users (id, email) VALUES
					(${ownerA}::uuid, ${`${ownerA}@workspace-survivor.invalid`}),
					(${ownerB}::uuid, ${`${ownerB}@workspace-survivor.invalid`})`;
				await setup`INSERT INTO public.categories (id, owner_id, workspace_id, name)
					VALUES (${categoryId}::uuid, ${ownerA}::uuid, ${workspaceId}, 'A category')`;
				await setup`INSERT INTO public.folders
					(id, owner_id, workspace_id, category_id, name)
					VALUES (${folderId}::uuid, ${ownerA}::uuid, ${workspaceId}, ${categoryId}::uuid, 'A folder')`;
				await setup`INSERT INTO public.tags (id, owner_id, workspace_id, name)
					VALUES (${tagId}::uuid, ${ownerA}::uuid, ${workspaceId}, 'A tag')`;
				await setup`INSERT INTO public.documents
					(id, owner_id, workspace_id, folder_id, category_id, title, content)
					VALUES (${documentId}::uuid, ${ownerA}::uuid, ${workspaceId},
						${folderId}::uuid, ${categoryId}::uuid, 'A document', '')`;
				await setup.begin(async (tx) => {
					await tx`SELECT public.acquire_account_purge_fence_lock(${ownerA}::uuid)`;
					await tx`INSERT INTO public.lifecycle_operations
						(actor_user_id, actor_subject_hash, idempotency_key,
						 operation_kind, status, fence_token_hash, completed_at)
					VALUES (${ownerA}::uuid, ${subjectHash(ownerA)}, ${crypto.randomUUID()},
						'purge', 'completed', ${subjectHash(`fence:${ownerA}`)}, now())`;
				});

				await withRuntimeTenant(runtime, ownerB, workspaceId, async (tx) => {
					await tx`UPDATE public.documents
						SET title = 'B retained document', owner_id = ${ownerB}::uuid
						WHERE id = ${documentId}::uuid`;
					await tx`UPDATE public.folders SET name = 'B retained folder', owner_id = ${ownerB}::uuid
						WHERE id = ${folderId}::uuid`;
					await tx`UPDATE public.categories SET name = 'B retained category', owner_id = ${ownerB}::uuid
						WHERE id = ${categoryId}::uuid`;
					await tx`UPDATE public.tags SET name = 'B retained tag', owner_id = ${ownerB}::uuid
						WHERE id = ${tagId}::uuid`;
				});
				let staleActorError: unknown;
				try {
					await withRuntimeTenant(
						runtime,
						ownerA,
						workspaceId,
						(tx) =>
							tx`UPDATE public.documents SET title = 'stale A'
							WHERE id = ${documentId}::uuid`,
					);
				} catch (error) {
					staleActorError = error;
				}
				expectFence(staleActorError);
				let foreignUpdated = -1;
				await withRuntimeTenant(
					runtime,
					ownerB,
					`foreign-${workspaceId}`,
					async (tx) => {
						const rows = await tx`UPDATE public.documents SET title = 'foreign'
							WHERE id = ${documentId}::uuid RETURNING id`;
						foreignUpdated = rows.length;
					},
				);
				expect(foreignUpdated).toBe(0);
				const [state] = await setup<
					Array<{ owner_id: string; title: string }>
				>`SELECT owner_id::text, title FROM public.documents WHERE id = ${documentId}::uuid`;
				expect(state).toEqual({
					owner_id: ownerB,
					title: "B retained document",
				});
			} finally {
				await setup.begin(async (tx) => {
					await tx`SET LOCAL session_replication_role = 'replica'`;
					await tx`DELETE FROM public.documents WHERE id = ${documentId}::uuid`;
					await tx`DELETE FROM public.folders WHERE id = ${folderId}::uuid`;
					await tx`DELETE FROM public.categories WHERE id = ${categoryId}::uuid`;
					await tx`DELETE FROM public.tags WHERE id = ${tagId}::uuid`;
					await tx`DELETE FROM public.lifecycle_operations WHERE actor_user_id = ${ownerA}::uuid`;
					await tx`DELETE FROM public.users WHERE id IN (${ownerA}::uuid, ${ownerB}::uuid)`;
				});
				await Promise.all([runtime.end(), setup.end()]);
			}
		}, 30_000);

		test("cleanup outbox leases prevent overlapping workers from deleting or releasing twice", async () => {
			const setup = postgres(ownerDatabaseUrl as string, { max: 1 });
			const ownerId = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const firstDeleteStarted = deferred<void>();
			const releaseFirstDelete = deferred<void>();
			const deletedKeys: string[] = [];
			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES (${ownerId}::uuid, ${`${ownerId}@cleanup-lease.invalid`})`;
				await setup`INSERT INTO public.documents (id, owner_id, title, content)
					VALUES (${documentId}::uuid, ${ownerId}::uuid, 'cleanup lease', '')`;
				for (const index of [0, 1]) {
					const sourceId = crypto.randomUUID();
					await setup`INSERT INTO public.attachment_storage_cleanup_outbox
						(source_kind, source_id, storage_key, document_id,
						 actor_user_id, owner_user_id, requested_by_user_id,
						 size, quota_operation_key)
					VALUES (
						'uncommitted_upload', ${sourceId}::uuid,
						${`cleanup-lease/${documentId}/${index}`}, ${documentId}::uuid,
						${ownerId}::uuid, ${ownerId}::uuid, ${ownerId}::uuid,
						1, ${`cleanup-operation-${sourceId}`}
					)`;
				}
				const first = drainAttachmentStorageCleanupOutbox({
					leaseOwner: `first-${crypto.randomUUID()}`,
					pageSize: 10,
					deleteObjects: async (keys) => {
						deletedKeys.push(...keys);
						firstDeleteStarted.resolve(undefined);
						await releaseFirstDelete.promise;
						return keys.length;
					},
				});

				await firstDeleteStarted.promise;
				const second = await drainAttachmentStorageCleanupOutbox({
					leaseOwner: `second-${crypto.randomUUID()}`,
					pageSize: 10,
					deleteObjects: async (keys) => {
						deletedKeys.push(...keys);
						return keys.length;
					},
				});
				expect(second).toEqual({
					claimed: 0,
					deleted: 0,
					deferred: 0,
					failed: 0,
				});
				releaseFirstDelete.resolve(undefined);
				expect(await first).toMatchObject({
					claimed: 2,
					deleted: 2,
					failed: 0,
				});
				expect(new Set(deletedKeys).size).toBe(2);
				expect(deletedKeys).toHaveLength(2);
				const [remaining] = await setup<{ count: number }[]>`
					SELECT count(*)::int AS count
					FROM public.attachment_storage_cleanup_outbox
					WHERE owner_user_id = ${ownerId}::uuid`;
				expect(remaining?.count).toBe(0);
			} finally {
				releaseFirstDelete.resolve(undefined);
				await setup`DELETE FROM public.attachment_storage_cleanup_outbox
					WHERE owner_user_id = ${ownerId}::uuid`;
				await setup`DELETE FROM public.documents WHERE id = ${documentId}::uuid`;
				await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
				await setup.end();
			}
		}, 30_000);

		test("signed admission abandonment is exact, fenced-safe, and concurrent-cleanup idempotent", async () => {
			const setup = postgres(ownerDatabaseUrl as string, { max: 1 });
			const runtime = postgres(runtimeDatabaseUrl as string, { max: 2 });
			const actorId = crypto.randomUUID();
			const foreignActorId = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const admissionId = crypto.randomUUID();
			const workspaceId = `workspace-${crypto.randomUUID()}`;
			const storageKey = `${workspaceId}/${actorId}/${documentId}/proof.png`;
			const tokenHash = subjectHash(`upload:${admissionId}`);
			const operationId = crypto.randomUUID();
			try {
				await setup`INSERT INTO public.users (id, email) VALUES
					(${actorId}::uuid, ${`${actorId}@abandon.invalid`}),
					(${foreignActorId}::uuid, ${`${foreignActorId}@abandon.invalid`})`;
				await setup`INSERT INTO public.documents
					(id, owner_id, workspace_id, title, content)
					VALUES (${documentId}::uuid, ${actorId}::uuid, ${workspaceId}, 'Proof doc', '')`;
				await setup`INSERT INTO public.pending_attachment_uploads
					(id, document_id, actor_user_id, workspace_id, storage_key,
					 token_hash, filename, mime_type, declared_size,
					 quota_operation_key, quota_state, url_issued_at, expires_at)
					VALUES (${admissionId}::uuid, ${documentId}::uuid, ${actorId}::uuid,
						${workspaceId}, ${storageKey}, ${tokenHash}, 'proof.png',
						'image/png', 7, ${`attachment:${documentId}:${storageKey}`},
						'not_required', now(), now() + interval '15 minutes')`;
				await setup.begin(async (tx) => {
					await tx`SELECT public.acquire_account_purge_fence_lock(${actorId}::uuid)`;
					await tx`INSERT INTO public.lifecycle_operations
						(id, actor_user_id, actor_subject_hash, idempotency_key,
						 operation_kind, status, fence_token_hash)
					VALUES (${operationId}::uuid, ${actorId}::uuid, ${subjectHash(actorId)},
						${crypto.randomUUID()}, 'purge', 'retryable',
						${subjectHash(`fence:${actorId}`)})`;
				});

				let foreignAccepted = true;
				await withRuntimeTenant(
					runtime,
					foreignActorId,
					workspaceId,
					async (tx) => {
						const [row] = await tx<{ abandoned: boolean }[]>`
						SELECT public.abandon_pending_attachment_upload(
							${admissionId}::uuid, ${documentId}::uuid, ${storageKey},
							${tokenHash}, NULL
						) AS abandoned`;
						foreignAccepted = row?.abandoned === true;
					},
				);
				expect(foreignAccepted).toBe(false);

				let tamperedAccepted = true;
				await withRuntimeTenant(runtime, actorId, workspaceId, async (tx) => {
					const [row] = await tx<{ abandoned: boolean }[]>`
						SELECT public.abandon_pending_attachment_upload(
							${admissionId}::uuid, ${documentId}::uuid, ${`${storageKey}.tampered`},
							${tokenHash}, NULL
						) AS abandoned`;
					tamperedAccepted = row?.abandoned === true;
				});
				expect(tamperedAccepted).toBe(false);

				const results: boolean[] = [];
				await Promise.all(
					[0, 1].map(() =>
						withRuntimeTenant(runtime, actorId, workspaceId, async (tx) => {
							const [row] = await tx<{ abandoned: boolean }[]>`
								SELECT public.abandon_pending_attachment_upload(
									${admissionId}::uuid, ${documentId}::uuid, ${storageKey},
									${tokenHash}, NULL
								) AS abandoned`;
							results.push(row?.abandoned === true);
						}),
					),
				);
				expect(results.sort()).toEqual([false, true]);
				const [counts] = await setup<
					Array<{ pending: number; cleanup: number; authorizations: number }>
				>`SELECT
					(SELECT count(*)::int FROM public.pending_attachment_uploads
					 WHERE id = ${admissionId}::uuid) AS pending,
					(SELECT count(*)::int FROM public.attachment_storage_cleanup_outbox
					 WHERE source_kind = 'pending_upload' AND source_id = ${admissionId}::uuid) AS cleanup,
					(SELECT count(*)::int FROM public.pending_attachment_cleanup_authorizations
					 WHERE admission_id = ${admissionId}::uuid) AS authorizations`;
				expect(counts).toEqual({ pending: 0, cleanup: 1, authorizations: 0 });
			} finally {
				await setup`UPDATE public.lifecycle_operations
					SET status = 'rejected', fence_token_hash = NULL, completed_at = now()
					WHERE id = ${operationId}::uuid`;
				await setup`DELETE FROM public.attachment_storage_cleanup_outbox
					WHERE source_id = ${admissionId}::uuid`;
				await setup.begin(async (tx) => {
					await tx`SET LOCAL session_replication_role = 'replica'`;
					await tx`DELETE FROM public.pending_attachment_uploads
						WHERE id = ${admissionId}::uuid`;
					await tx`DELETE FROM public.documents WHERE id = ${documentId}::uuid`;
					await tx`DELETE FROM public.lifecycle_operations WHERE id = ${operationId}::uuid`;
					await tx`DELETE FROM public.users WHERE id IN (${actorId}::uuid, ${foreignActorId}::uuid)`;
				});
				await Promise.all([setup.end(), runtime.end()]);
			}
		});

		test("completed fences reject Better Auth profile and email mutations with the stable public error", async () => {
			const setup = postgres(ownerDatabaseUrl as string, { max: 1 });
			const app = new Elysia().use(authRoutes);
			const email = `${crypto.randomUUID()}@auth-fence.invalid`;
			let userId: string | undefined;
			try {
				const signup = await app.handle(
					new Request("http://localhost:50700/api/auth/sign-up/email", {
						method: "POST",
						headers: {
							"content-type": "application/json",
							origin: "http://localhost:50701",
							"x-forwarded-for": `auth-fence-${crypto.randomUUID()}`,
						},
						body: JSON.stringify({
							name: "Fenced Better Auth User",
							email,
							password: "password-12345",
						}),
					}),
				);
				expect(signup.status).toBe(200);
				const signupBody = (await signup.json()) as { user?: { id?: string } };
				const actorId = signupBody.user?.id;
				userId = actorId;
				const cookie = signup.headers.get("set-cookie")?.split(";")[0];
				if (!actorId || !cookie)
					throw new Error("Better Auth signup has no session");

				await setup.begin(async (tx) => {
					await tx`SELECT public.acquire_account_purge_fence_lock(${actorId}::uuid)`;
					await tx`INSERT INTO public.lifecycle_operations
						(actor_user_id, actor_subject_hash, idempotency_key,
						 operation_kind, status, fence_token_hash, completed_at)
					VALUES (
						${actorId}::uuid, ${subjectHash(actorId)},
						${`auth-completed-${crypto.randomUUID()}`},
						'purge', 'completed', ${subjectHash(`fence:${actorId}`)}, now()
					)`;
				});
				const [verificationBefore] = await setup<{ count: number }[]>`
					SELECT count(*)::int AS count FROM public.verifications`;
				for (const [path, body] of [
					["update-user", { name: "Must not change" }],
					[
						"change-email",
						{ newEmail: `${crypto.randomUUID()}@invalid.local` },
					],
				] as const) {
					const response = await app.handle(
						new Request(`http://localhost:50700/api/auth/${path}`, {
							method: "POST",
							headers: {
								"content-type": "application/json",
								cookie,
								origin: "http://localhost:50701",
							},
							body: JSON.stringify(body),
						}),
					);
					expect(response.status).toBe(409);
					expect(await response.json()).toEqual({
						error: "Account deletion is in progress",
						code: "ACCOUNT_PURGE_FENCED",
					});
				}
				const [state] = await setup<
					{ name: string | null; verifications: number }[]
				>`
					SELECT account.name,
						(SELECT count(*)::int FROM public.verifications) AS verifications
					FROM public.users AS account
					WHERE account.id = ${actorId}::uuid`;
				expect(state).toEqual({
					name: "Fenced Better Auth User",
					verifications: verificationBefore?.count ?? 0,
				});
			} finally {
				if (userId) {
					const cleanupUserId = userId;
					await setup.begin(async (tx) => {
						await tx`SET LOCAL session_replication_role = 'replica'`;
						await tx`DELETE FROM public.sessions WHERE user_id = ${cleanupUserId}::uuid`;
						await tx`DELETE FROM public.accounts WHERE user_id = ${cleanupUserId}::uuid`;
						await tx`DELETE FROM public.lifecycle_operations WHERE actor_user_id = ${cleanupUserId}::uuid`;
						await tx`DELETE FROM public.users WHERE id = ${cleanupUserId}::uuid`;
					});
				}
				await setup.end();
			}
		}, 30_000);

		test("real pipeline cancellation updates active rows after the fence and lifecycle completes", async () => {
			if (!redisUrl)
				throw new Error("REDIS_URL is required for cancellation integration");
			const setup = postgres(ownerDatabaseUrl as string, { max: 1 });
			const lifecycleClient = createDatabaseClient(
				runtimeDatabaseUrl as string,
				{
					max: 3,
				},
			);
			const cancellation = createAccountPipelineCancellation({
				redisUrl,
				databaseUrl: runtimeDatabaseUrl as string,
			});
			const ownerId = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const generationId = crypto.randomUUID();
			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES (${ownerId}::uuid, ${`${ownerId}@real-cancellation.invalid`})`;
				await setup`INSERT INTO public.documents (id, owner_id, title, content)
					VALUES (${documentId}::uuid, ${ownerId}::uuid, 'active run', '')`;
				await setup`INSERT INTO public.document_pipeline_runs
					(document_id, owner_id, generation_id, revision, source, status)
					VALUES (
						${documentId}::uuid, ${ownerId}::uuid, ${generationId}::uuid,
						'active-revision', 'interactive', 'processing'
					)`;
				await setup`INSERT INTO public.document_pipeline_batches
					(document_id, generation_id, batch_index, chunk_start, chunk_end, status)
					VALUES (${documentId}::uuid, ${generationId}::uuid, 0, 0, 1, 'processing')`;

				const lifecycle = createPersistentLifecycleService(
					{
						verifyPurgeFence: async () => {},
						deleteObjects: async (keys) => keys.length,
						cancelAccountJobs: async (actorUserId, signal) => {
							const result = await cancellation.cancelActorPipeline(
								actorUserId,
								signal,
							);
							return result.runs + result.jobs;
						},
						clearAccountRedisState: async () => 0,
						removeCollaborationState: async () => 0,
						removeGraphState: async (ids) => ids.length,
					},
					{
						withActorTransaction: (actorUserId, operation) =>
							withTenantDatabase(
								lifecycleClient.db,
								{ userId: actorUserId, role: "user", source: "personal" },
								operation,
							),
					},
					[],
				);
				const context = {
					actorUserId: ownerId,
					requestId: crypto.randomUUID(),
					idempotencyKey: `real-cancellation-${crypto.randomUUID()}`,
					reason: "account_deletion" as const,
				};
				expect(
					await lifecycle.purgeUserData(context, { fenceToken: "real-cancel" }),
				).toMatchObject({ status: "completed" });
				expect(
					await lifecycle.purgeUserData(context, { fenceToken: "real-cancel" }),
				).toMatchObject({ status: "already_completed" });
				const [remaining] = await setup<{ documents: number; runs: number }[]>`
					SELECT
						(SELECT count(*)::int FROM public.documents WHERE id = ${documentId}::uuid) AS documents,
						(SELECT count(*)::int FROM public.document_pipeline_runs WHERE generation_id = ${generationId}::uuid) AS runs`;
				expect(remaining).toEqual({ documents: 0, runs: 0 });
			} finally {
				await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
				await Promise.all([
					cancellation.close(),
					lifecycleClient.client.end(),
					setup.end(),
				]);
			}
		}, 30_000);

		test("a parent owner transfer cannot race a child write past the new owner's fence", async () => {
			const setup = postgres(ownerDatabaseUrl as string, { max: 2 });
			const transfer = postgres(ownerDatabaseUrl as string, { max: 1 });
			const fence = postgres(ownerDatabaseUrl as string, { max: 1 });
			const child = postgres(runtimeDatabaseUrl as string, { max: 1 });
			const ownerA = crypto.randomUUID();
			const ownerB = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const transferReady = deferred<void>();
			const releaseTransfer = deferred<void>();
			const fenceReady = deferred<string>();
			const releaseFence = deferred<void>();
			let transferTransaction: Promise<unknown> | undefined;
			let fenceTransaction: Promise<unknown> | undefined;
			let childWrite: Promise<unknown> | undefined;
			try {
				await setup`INSERT INTO public.users (id, email) VALUES
					(${ownerA}::uuid, ${`${ownerA}@parent-transfer.invalid`}),
					(${ownerB}::uuid, ${`${ownerB}@parent-transfer.invalid`})`;
				await setup`INSERT INTO public.documents (id, owner_id, title, content)
					VALUES (${documentId}::uuid, ${ownerA}::uuid, 'owner transfer', '')`;

				transferTransaction = transfer.begin(async (tx) => {
					await tx`UPDATE public.documents SET owner_id = ${ownerB}::uuid
						WHERE id = ${documentId}::uuid`;
					transferReady.resolve(undefined);
					await releaseTransfer.promise;
				});
				await transferReady.promise;

				fenceTransaction = fence.begin(async (tx) => {
					await tx`SELECT public.acquire_account_purge_fence_lock(${ownerB}::uuid)`;
					const [operation] = await tx<{ id: string }[]>`
						INSERT INTO public.lifecycle_operations
							(actor_user_id, actor_subject_hash, idempotency_key,
							 operation_kind, status, fence_token_hash)
						VALUES (
							${ownerB}::uuid,
							${subjectHash(ownerB)},
							${`transfer-fence-${crypto.randomUUID()}`},
							'purge', 'retryable', ${subjectHash(`fence:${ownerB}`)}
						)
						RETURNING id::text`;
					if (!operation?.id)
						throw new Error("failed to establish transfer fence");
					fenceReady.resolve(operation.id);
					await releaseFence.promise;
				});
				childWrite = withRuntimeTenant(
					child,
					ownerB,
					null,
					(tx) =>
						tx`INSERT INTO public.versions
						(document_id, content, created_by)
					VALUES (${documentId}::uuid, 'racing child', ${ownerB}::uuid)`,
				);
				releaseTransfer.resolve(undefined);
				await fenceReady.promise;
				releaseFence.resolve(undefined);
				await transferTransaction;
				await fenceTransaction;
				let childError: unknown;
				try {
					await childWrite;
				} catch (error) {
					childError = error;
				}
				expectFence(childError);
				const [count] = await setup<{ count: number }[]>`
					SELECT count(*)::int AS count FROM public.versions
					WHERE document_id = ${documentId}::uuid`;
				expect(count?.count).toBe(0);
			} finally {
				releaseTransfer.resolve(undefined);
				releaseFence.resolve(undefined);
				await Promise.allSettled(
					[transferTransaction, fenceTransaction, childWrite].filter(
						(value): value is Promise<unknown> => value !== undefined,
					),
				);
				await setup`DELETE FROM public.lifecycle_operations
					WHERE actor_user_id = ${ownerB}::uuid AND status = 'retryable'`;
				await setup`DELETE FROM public.users
					WHERE id IN (${ownerA}::uuid, ${ownerB}::uuid)`;
				await Promise.all([
					setup.end(),
					transfer.end(),
					fence.end(),
					child.end(),
				]);
			}
		}, 30_000);

		test("set-based cross-owner writes lock subjects globally despite reversed source order", async () => {
			const setup = postgres(ownerDatabaseUrl as string, { max: 1 });
			const writerA = postgres(runtimeDatabaseUrl as string, { max: 1 });
			const writerB = postgres(runtimeDatabaseUrl as string, { max: 1 });
			const ownerA = crypto.randomUUID();
			const ownerB = crypto.randomUUID();
			const documentA = crypto.randomUUID();
			const documentB = crypto.randomUUID();
			const firstPrefix = `global-order-a-${crypto.randomUUID()}`;
			const secondPrefix = `global-order-b-${crypto.randomUUID()}`;
			try {
				await setup`INSERT INTO public.users (id, email) VALUES
					(${ownerA}::uuid, ${`${ownerA}@global-order.invalid`}),
					(${ownerB}::uuid, ${`${ownerB}@global-order.invalid`})`;
				await setup`INSERT INTO public.documents (id, owner_id, title, content) VALUES
					(${documentA}::uuid, ${ownerA}::uuid, 'global A', ''),
					(${documentB}::uuid, ${ownerB}::uuid, 'global B', '')`;

				const insertPair = (
					client: postgres.Sql,
					actorId: string,
					firstDocument: string,
					firstOwner: string,
					secondDocument: string,
					secondOwner: string,
					prefix: string,
				) =>
					withRuntimeTenant(
						client,
						actorId,
						null,
						async (tx) => {
							await tx`SET LOCAL statement_timeout = '3s'`;
							await tx`
							INSERT INTO public.document_pipeline_runs
								(document_id, owner_id, generation_id, revision, source)
							SELECT input.document_id, input.owner_id, gen_random_uuid(),
								${prefix} || '-' || input.ord::text ||
								CASE WHEN input.ord = 2
									THEN (SELECT '' FROM pg_sleep(0.2))
									ELSE ''
								END,
								'interactive'
							FROM (VALUES
								(1, ${firstDocument}::uuid, ${firstOwner}::uuid),
								(2, ${secondDocument}::uuid, ${secondOwner}::uuid)
							) AS input(ord, document_id, owner_id)
							ORDER BY input.ord`;
						},
						"admin",
					);

				await Promise.all([
					insertPair(
						writerA,
						ownerA,
						documentA,
						ownerA,
						documentB,
						ownerB,
						firstPrefix,
					),
					insertPair(
						writerB,
						ownerB,
						documentB,
						ownerB,
						documentA,
						ownerA,
						secondPrefix,
					),
				]);
				const [admitted] = await setup<{ count: number }[]>`
					SELECT count(*)::int AS count
					FROM public.document_pipeline_runs
					WHERE revision LIKE ${`${firstPrefix}%`}
						OR revision LIKE ${`${secondPrefix}%`}`;
				expect(admitted?.count).toBe(4);

				const fenceOperation = await setup<{ id: string }[]>`
					WITH locked AS (
						SELECT public.acquire_account_purge_fence_lock(${ownerB}::uuid)
					)
					INSERT INTO public.lifecycle_operations
						(actor_user_id, actor_subject_hash, idempotency_key,
						 operation_kind, status, fence_token_hash)
					SELECT
						${ownerB}::uuid, ${subjectHash(ownerB)},
						${`global-order-fence-${crypto.randomUUID()}`},
						'purge', 'retryable', ${subjectHash(`fence:${ownerB}`)}
					FROM locked
					RETURNING id::text`;
				const rejectedPrefix = `global-order-rejected-${crypto.randomUUID()}`;
				let rejected: unknown;
				try {
					await insertPair(
						writerA,
						ownerA,
						documentA,
						ownerA,
						documentB,
						ownerB,
						rejectedPrefix,
					);
				} catch (error) {
					rejected = error;
				}
				expectFence(rejected);
				const [rolledBack] = await setup<{ count: number }[]>`
					SELECT count(*)::int AS count
					FROM public.document_pipeline_runs
					WHERE revision LIKE ${`${rejectedPrefix}%`}`;
				expect(rolledBack?.count).toBe(0);
				await setup`DELETE FROM public.lifecycle_operations
					WHERE id = ${fenceOperation[0]?.id ?? crypto.randomUUID()}::uuid`;
			} finally {
				await setup`DELETE FROM public.document_pipeline_runs
					WHERE document_id IN (${documentA}::uuid, ${documentB}::uuid)`;
				await setup`DELETE FROM public.lifecycle_operations
					WHERE actor_user_id IN (${ownerA}::uuid, ${ownerB}::uuid)
						AND status = 'retryable'`;
				await setup`DELETE FROM public.users
					WHERE id IN (${ownerA}::uuid, ${ownerB}::uuid)`;
				await Promise.all([setup.end(), writerA.end(), writerB.end()]);
			}
		}, 30_000);

		test("purging a workspace peer removes that peer's versions and attachments only", async () => {
			const setup = postgres(ownerDatabaseUrl as string, { max: 1 });
			const lifecycleClient = createDatabaseClient(
				runtimeDatabaseUrl as string,
				{
					max: 3,
				},
			);
			const ownerA = crypto.randomUUID();
			const peerB = crypto.randomUUID();
			const workspaceId = `peer-cleanup-${crypto.randomUUID()}`;
			const documentId = crypto.randomUUID();
			const peerVersionId = crypto.randomUUID();
			const ownerVersionId = crypto.randomUUID();
			const peerAttachmentId = crypto.randomUUID();
			const ownerAttachmentId = crypto.randomUUID();
			const peerKey = `${workspaceId}/${peerB}/${documentId}/peer.png`;
			const ownerKey = `${workspaceId}/${ownerA}/${documentId}/owner.png`;
			const deletedKeys: string[] = [];
			try {
				await setup`INSERT INTO public.users (id, email) VALUES
					(${ownerA}::uuid, ${`${ownerA}@peer-cleanup.invalid`}),
					(${peerB}::uuid, ${`${peerB}@peer-cleanup.invalid`})`;
				await setup`INSERT INTO public.documents
					(id, owner_id, workspace_id, title, content)
					VALUES (${documentId}::uuid, ${ownerA}::uuid, ${workspaceId}, 'peer parent', '')`;
				await setup`INSERT INTO public.versions
					(id, document_id, workspace_id, content, created_by) VALUES
					(${peerVersionId}::uuid, ${documentId}::uuid, ${workspaceId}, 'peer', ${peerB}::uuid),
					(${ownerVersionId}::uuid, ${documentId}::uuid, ${workspaceId}, 'owner', ${ownerA}::uuid)`;
				await setup`INSERT INTO public.attachments
					(id, document_id, workspace_id, uploaded_by, filename, mime_type, size, storage_key) VALUES
					(${peerAttachmentId}::uuid, ${documentId}::uuid, ${workspaceId}, ${peerB}::uuid, 'peer.png', 'image/png', 4, ${peerKey}),
					(${ownerAttachmentId}::uuid, ${documentId}::uuid, ${workspaceId}, ${ownerA}::uuid, 'owner.png', 'image/png', 4, ${ownerKey})`;
				let unverifiedResolverError: unknown;
				try {
					await withRuntimeTenant(
						lifecycleClient.client,
						peerB,
						workspaceId,
						(tx) =>
							tx`SELECT public.lifecycle_child_document_owner(
								${documentId}::uuid, ${peerB}::uuid
							)`,
					);
				} catch (error) {
					unverifiedResolverError = error;
				}
				expect(unverifiedResolverError).toBeInstanceOf(Error);
				expect((unverifiedResolverError as Error).message).toContain(
					"lifecycle_cleanup_not_authorized",
				);

				const lifecycle = createPersistentLifecycleService(
					{
						verifyPurgeFence: async () => {},
						deleteObjects: async (keys) => {
							deletedKeys.push(...keys);
							return keys.length;
						},
						cancelAccountJobs: async () => 0,
						clearAccountRedisState: async () => 0,
						removeCollaborationState: async () => 0,
						removeGraphState: async () => 0,
						attachmentStorageQuotaAdmission: {
							reserve: async () => ({ id: "peer-cleanup-reservation" }),
							finalize: async () => {},
							releaseReservation: async () => {},
							releaseCommitted: async () => {},
						},
					},
					{
						withActorTransaction: (actorUserId, operation) =>
							withTenantDatabase(
								lifecycleClient.db,
								{ userId: actorUserId, role: "user", source: "personal" },
								operation,
							),
					},
					[],
				);
				expect(
					await lifecycle.purgeUserData(
						{
							actorUserId: peerB,
							requestId: crypto.randomUUID(),
							idempotencyKey: `peer-purge-${crypto.randomUUID()}`,
							reason: "account_deletion",
						},
						{ fenceToken: "peer-cleanup" },
					),
				).toMatchObject({ status: "completed" });
				expect(deletedKeys).toEqual([peerKey]);
				const [state] = await setup<
					{
						documents: number;
						peerVersions: number;
						ownerVersions: number;
						peerAttachments: number;
						ownerAttachments: number;
					}[]
				>`SELECT
						(SELECT count(*)::int FROM public.documents WHERE id = ${documentId}::uuid) AS documents,
						(SELECT count(*)::int FROM public.versions WHERE id = ${peerVersionId}::uuid) AS "peerVersions",
						(SELECT count(*)::int FROM public.versions WHERE id = ${ownerVersionId}::uuid) AS "ownerVersions",
						(SELECT count(*)::int FROM public.attachments WHERE id = ${peerAttachmentId}::uuid) AS "peerAttachments",
						(SELECT count(*)::int FROM public.attachments WHERE id = ${ownerAttachmentId}::uuid) AS "ownerAttachments"`;
				expect(state).toEqual({
					documents: 1,
					peerVersions: 0,
					ownerVersions: 1,
					peerAttachments: 0,
					ownerAttachments: 1,
				});
			} finally {
				await setup`UPDATE public.lifecycle_operations
					SET actor_user_id = NULL
					WHERE actor_user_id = ${peerB}::uuid`;
				await setup`DELETE FROM public.attachments
					WHERE document_id = ${documentId}::uuid`;
				await setup`DELETE FROM public.versions
					WHERE document_id = ${documentId}::uuid`;
				await setup`DELETE FROM public.documents
					WHERE id = ${documentId}::uuid`;
				await setup`DELETE FROM public.users
					WHERE id IN (${ownerA}::uuid, ${peerB}::uuid)`;
				await Promise.all([setup.end(), lifecycleClient.client.end()]);
			}
		}, 30_000);
	},
);
