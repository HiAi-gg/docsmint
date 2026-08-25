import { describe, expect, test } from "bun:test";
import { createDatabaseClient } from "@hiai-docs/db/client";
import { withTenantDatabase } from "@hiai-docs/db/with-tenant";
import { Elysia } from "elysia";
import postgres from "postgres";
import { authRoutes } from "../api/routes/auth";
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
