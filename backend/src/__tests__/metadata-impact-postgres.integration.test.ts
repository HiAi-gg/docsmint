import { describe, expect, test } from "bun:test";
import {
	createDatabaseClient,
	type DatabaseQueryObservation,
} from "@hiai-docs/db/client";
import {
	type TenantContext,
	type TenantTransaction,
	withTenantDatabase,
} from "@hiai-docs/db/with-tenant";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import postgres from "postgres";
import { documentRoutes } from "../api/routes/documents";
import { versionRoutes } from "../api/routes/versions";
import { config } from "../lib/config";
import { contentHash } from "../lib/content-hash";
import {
	createPersistentLifecycleService,
	LifecycleFenceRejectedError,
} from "../lib/lifecycle-service";
import {
	drainMetadataReembedOutbox,
	reembedDocsByTag,
	reembedDocsInCategory,
	reembedDocsInFolder,
	snapshotDocumentMetadataImpact,
	snapshotMetadataImpact,
} from "../lib/reembed";
import {
	acquireTenantTopologyLock,
	tenantTopologyLockKey,
} from "../lib/topology-serialization";
import { JOB_IDS } from "../queue/contracts";
import { getPipelineQueue } from "../queue/queues";

const databaseUrl = Bun.env.CONTENT_ACCESS_TEST_DATABASE_URL?.trim();

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

async function waitForBlock(
	observer: postgres.Sql,
	blockedPid: number,
	blockerPid: number,
): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const [row] =
			await observer`SELECT pg_blocking_pids(${blockedPid}) AS blocker_pids`;
		if ((row?.blocker_pids as number[] | undefined)?.includes(blockerPid))
			return;
		await Bun.sleep(10);
	}
	throw new Error(
		"descendant attach did not block on the subtree folder locks",
	);
}

async function waitForSessionBlockedBy(
	observer: postgres.Sql,
	blockerPid: number,
): Promise<number> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const rows = await observer<{ pid: number }[]>`
			SELECT pid
			FROM pg_stat_activity
			WHERE pid <> pg_backend_pid()
				AND ${blockerPid} = ANY(pg_blocking_pids(pid))
			ORDER BY pid
			LIMIT 1`;
		if (rows[0]?.pid) return rows[0].pid;
		await Bun.sleep(10);
	}
	throw new Error("metadata outbox stage did not block on the worker session");
}

async function waitForApplicationBlockedBy(
	observer: postgres.Sql,
	blockerPid: number,
	applicationName: string,
): Promise<number> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const rows = await observer<{ pid: number }[]>`
			SELECT pid
			FROM pg_stat_activity
			WHERE application_name = ${applicationName}
				AND ${blockerPid} = ANY(pg_blocking_pids(pid))
			ORDER BY pid
			LIMIT 1`;
		if (rows[0]?.pid) return rows[0].pid;
		await Bun.sleep(10);
	}
	throw new Error("benchmark cleanup did not block on the worker session");
}

function expectedDocumentPipelineLockKey(documentId: string): bigint {
	const prefix = new Bun.CryptoHasher("sha256")
		.update(JSON.stringify(["docsmint:document-pipeline:v1", documentId]))
		.digest("hex")
		.slice(0, 16);
	const unsigned = BigInt(`0x${prefix}`);
	return unsigned >= 1n << 63n ? unsigned - (1n << 64n) : unsigned;
}

describe.skipIf(!databaseUrl)(
	"recursive metadata impact PostgreSQL contract",
	() => {
		test("public re-embed helpers keep owner and external-workspace rows in their canonical tenants", async () => {
			const setup = postgres(databaseUrl as string, { max: 1 });
			const ownerId = crypto.randomUUID();
			const peerOwnerId = crypto.randomUUID();
			const workspaceId = `metadata-helper-${crypto.randomUUID()}`;
			const foreignWorkspaceId = `metadata-helper-foreign-${crypto.randomUUID()}`;
			const personalFolderId = crypto.randomUUID();
			const workspaceFolderId = crypto.randomUUID();
			const personalCategoryId = crypto.randomUUID();
			const workspaceCategoryId = crypto.randomUUID();
			const personalTagId = crypto.randomUUID();
			const workspaceTagId = crypto.randomUUID();
			const personalFolderDocumentId = crypto.randomUUID();
			const workspaceFolderDocumentId = crypto.randomUUID();
			const personalCategoryDocumentId = crypto.randomUUID();
			const workspaceCategoryDocumentId = crypto.randomUUID();
			const personalTagDocumentId = crypto.randomUUID();
			const workspaceTagDocumentId = crypto.randomUUID();
			const peerWorkspaceFolderDocumentId = crypto.randomUUID();
			const peerWorkspaceCategoryDocumentId = crypto.randomUUID();
			const peerWorkspaceTagDocumentId = crypto.randomUUID();
			const peerPersonalFolderDocumentId = crypto.randomUUID();
			const peerPersonalCategoryDocumentId = crypto.randomUUID();
			const peerPersonalTagDocumentId = crypto.randomUUID();
			const foreignWorkspaceTagDocumentId = crypto.randomUUID();

			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES
						(${ownerId}::uuid, ${`${ownerId}@metadata-helper.invalid`}),
						(${peerOwnerId}::uuid, ${`${peerOwnerId}@metadata-helper.invalid`})`;
				await setup`INSERT INTO public.categories
					(id, owner_id, workspace_id, name)
					VALUES
						(${personalCategoryId}::uuid, ${ownerId}::uuid, NULL, 'personal helper'),
						(${workspaceCategoryId}::uuid, ${ownerId}::uuid, ${workspaceId}, 'workspace helper')`;
				await setup`INSERT INTO public.tags
					(id, owner_id, workspace_id, name)
					VALUES
						(${personalTagId}::uuid, ${ownerId}::uuid, NULL, 'personal helper'),
						(${workspaceTagId}::uuid, ${ownerId}::uuid, ${workspaceId}, 'workspace helper')`;
				await setup`INSERT INTO public.folders
					(id, owner_id, workspace_id, parent_id, category_id, name)
					VALUES
						(${personalFolderId}::uuid, ${ownerId}::uuid, NULL, NULL, NULL, 'personal helper'),
						(${workspaceFolderId}::uuid, ${ownerId}::uuid, ${workspaceId}, NULL, NULL, 'workspace helper')`;
				await setup`INSERT INTO public.documents
					(id, owner_id, workspace_id, folder_id, category_id, title, content)
					VALUES
						(${personalFolderDocumentId}::uuid, ${ownerId}::uuid, NULL, ${personalFolderId}::uuid, NULL, 'personal folder', ''),
						(${workspaceFolderDocumentId}::uuid, ${ownerId}::uuid, ${workspaceId}, ${workspaceFolderId}::uuid, NULL, 'workspace folder', ''),
						(${personalCategoryDocumentId}::uuid, ${ownerId}::uuid, NULL, NULL, ${personalCategoryId}::uuid, 'personal category', ''),
						(${workspaceCategoryDocumentId}::uuid, ${ownerId}::uuid, ${workspaceId}, NULL, ${workspaceCategoryId}::uuid, 'workspace category', ''),
						(${personalTagDocumentId}::uuid, ${ownerId}::uuid, NULL, NULL, NULL, 'personal tag', ''),
						(${workspaceTagDocumentId}::uuid, ${ownerId}::uuid, ${workspaceId}, NULL, NULL, 'workspace tag', ''),
						(${peerWorkspaceFolderDocumentId}::uuid, ${peerOwnerId}::uuid, ${workspaceId}, ${workspaceFolderId}::uuid, NULL, 'peer workspace folder', ''),
						(${peerWorkspaceCategoryDocumentId}::uuid, ${peerOwnerId}::uuid, ${workspaceId}, NULL, ${workspaceCategoryId}::uuid, 'peer workspace category', ''),
						(${peerWorkspaceTagDocumentId}::uuid, ${peerOwnerId}::uuid, ${workspaceId}, NULL, NULL, 'peer workspace tag', ''),
						(${peerPersonalFolderDocumentId}::uuid, ${peerOwnerId}::uuid, NULL, ${personalFolderId}::uuid, NULL, 'peer personal folder', ''),
						(${peerPersonalCategoryDocumentId}::uuid, ${peerOwnerId}::uuid, NULL, NULL, ${personalCategoryId}::uuid, 'peer personal category', ''),
						(${peerPersonalTagDocumentId}::uuid, ${peerOwnerId}::uuid, NULL, NULL, NULL, 'peer personal tag', ''),
						(${foreignWorkspaceTagDocumentId}::uuid, ${peerOwnerId}::uuid, ${foreignWorkspaceId}, NULL, NULL, 'foreign workspace tag', '')`;
				await setup`INSERT INTO public.document_tags
					(workspace_id, document_id, tag_id)
					VALUES
						(NULL, ${personalTagDocumentId}::uuid, ${personalTagId}::uuid),
						(NULL, ${peerPersonalTagDocumentId}::uuid, ${personalTagId}::uuid),
						(${workspaceId}, ${workspaceTagDocumentId}::uuid, ${workspaceTagId}::uuid),
						(${workspaceId}, ${peerWorkspaceTagDocumentId}::uuid, ${workspaceTagId}::uuid),
						(${foreignWorkspaceId}, ${foreignWorkspaceTagDocumentId}::uuid, ${workspaceTagId}::uuid)`;

				const personalFolder = await reembedDocsInFolder(
					personalFolderId,
					ownerId,
				);
				const workspaceFolder = await reembedDocsInFolder(
					workspaceFolderId,
					ownerId,
					workspaceId,
				);
				const workspaceAgainstPersonalFolder = await reembedDocsInFolder(
					personalFolderId,
					ownerId,
					workspaceId,
				);
				const personalCategory = await reembedDocsInCategory(
					personalCategoryId,
					ownerId,
				);
				const workspaceCategory = await reembedDocsInCategory(
					workspaceCategoryId,
					ownerId,
					workspaceId,
				);
				const personalTag = await reembedDocsByTag(personalTagId, ownerId);
				const workspaceTag = await reembedDocsByTag(
					workspaceTagId,
					ownerId,
					workspaceId,
				);

				expect(personalFolder).toBe(1);
				expect(workspaceFolder).toBe(2);
				expect(workspaceAgainstPersonalFolder).toBe(0);
				expect(personalCategory).toBe(1);
				expect(workspaceCategory).toBe(2);
				expect(personalTag).toBe(1);
				expect(workspaceTag).toBe(2);
				const queued = await setup<{ document_id: string }[]>`
					SELECT document_id::text
					FROM public.document_pipeline_runs
					WHERE document_id IN (
						${personalFolderDocumentId}::uuid,
						${workspaceFolderDocumentId}::uuid,
						${personalCategoryDocumentId}::uuid,
						${workspaceCategoryDocumentId}::uuid,
						${personalTagDocumentId}::uuid,
						${workspaceTagDocumentId}::uuid,
						${peerWorkspaceFolderDocumentId}::uuid,
						${peerWorkspaceCategoryDocumentId}::uuid,
						${peerWorkspaceTagDocumentId}::uuid,
						${peerPersonalFolderDocumentId}::uuid,
						${peerPersonalCategoryDocumentId}::uuid,
						${peerPersonalTagDocumentId}::uuid,
						${foreignWorkspaceTagDocumentId}::uuid
					)`;
				expect(queued.map(({ document_id }) => document_id).sort()).toEqual(
					[
						personalFolderDocumentId,
						workspaceFolderDocumentId,
						personalCategoryDocumentId,
						workspaceCategoryDocumentId,
						personalTagDocumentId,
						workspaceTagDocumentId,
						peerWorkspaceFolderDocumentId,
						peerWorkspaceCategoryDocumentId,
						peerWorkspaceTagDocumentId,
					].sort(),
				);
			} finally {
				await setup`DELETE FROM public.users
					WHERE id IN (${ownerId}::uuid, ${peerOwnerId}::uuid)`;
				await setup.end();
			}
		});

		test("releases the topology transaction before BullMQ bulk enqueue I/O", async () => {
			const setup = postgres(databaseUrl as string, { max: 1 });
			const contender = postgres(databaseUrl as string, { max: 1 });
			const ownerId = crypto.randomUUID();
			const folderId = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const enqueueEntered = deferred<void>();
			const releaseEnqueue = deferred<void>();
			const queue = getPipelineQueue("prepare", config.REDIS_URL);
			const queueTarget = queue as unknown as {
				addBulk: (jobs: unknown[]) => Promise<unknown[]>;
			};
			const originalAddBulk = queueTarget.addBulk.bind(queue);
			let helperTask: Promise<number> | undefined;

			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES (${ownerId}::uuid, ${`${ownerId}@metadata-release.invalid`})`;
				await setup`INSERT INTO public.folders (id, owner_id, name)
					VALUES (${folderId}::uuid, ${ownerId}::uuid, 'release probe')`;
				await setup`INSERT INTO public.documents
					(id, owner_id, folder_id, title, content)
					VALUES (${documentId}::uuid, ${ownerId}::uuid, ${folderId}::uuid, 'release probe', '')`;

				queueTarget.addBulk = async (jobs: unknown[]) => {
					enqueueEntered.resolve();
					await releaseEnqueue.promise;
					return originalAddBulk(jobs);
				};
				helperTask = reembedDocsInFolder(folderId, ownerId);
				await Promise.race([
					enqueueEntered.promise,
					Bun.sleep(2_000).then(() => {
						throw new Error(
							"re-embed helper did not reach BullMQ bulk enqueue",
						);
					}),
				]);

				const key = tenantTopologyLockKey({
					userId: ownerId,
					role: "user",
					source: "personal",
				});
				const probeRows = await contender`
					SELECT pg_try_advisory_lock(${key.toString()}::bigint) AS acquired`;
				const probe = probeRows[0] as { acquired: boolean } | undefined;
				expect(probe?.acquired).toBe(true);
				if (probe?.acquired) {
					await contender`
						SELECT pg_advisory_unlock(${key.toString()}::bigint)`;
				}
			} finally {
				releaseEnqueue.resolve();
				await helperTask?.catch(() => undefined);
				queueTarget.addBulk = originalAddBulk;
				await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
				await Promise.all([setup.end(), contender.end()]);
			}
		});

		test("stages only embedding state and preserves the document concurrency token and revision", async () => {
			const setup = postgres(databaseUrl as string, { max: 1 });
			const snapshotClient = createDatabaseClient(databaseUrl as string, {
				max: 1,
			});
			const ownerId = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const context: TenantContext = {
				userId: ownerId,
				role: "user",
				source: "personal",
			};
			const queue = getPipelineQueue("prepare", config.REDIS_URL);
			const updatedAt = "2024-06-01T12:34:56.123456Z";
			let generationId: string | undefined;

			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES (${ownerId}::uuid, ${`${ownerId}@metadata-fields.invalid`})`;
				await setup`INSERT INTO public.documents (
					id, owner_id, title, content, content_json, metadata, visibility,
					content_hash, embedding_status, embedding_error_code, updated_at
				) VALUES (
					${documentId}::uuid,
					${ownerId}::uuid,
					'visible title',
					'visible body',
					'{"type":"doc"}'::jsonb,
					'{"review":"preserve"}'::jsonb,
					'public',
					'preserved-content-revision',
					'ready',
					'previous-provider-error',
					${updatedAt}::timestamp
				)`;
				const snapshot = await withTenantDatabase(
					snapshotClient.db,
					context,
					(tx) => snapshotDocumentMetadataImpact(tx, context, documentId),
				);
				const [outbox] = await setup<{ id: string }[]>`
					SELECT id::text FROM public.metadata_reembed_outbox
					WHERE operation_id = ${snapshot.operationId}::uuid`;
				if (!outbox) throw new Error("metadata field outbox row missing");
				generationId = outbox.id;
				const [before] = await setup<{ preserved: Record<string, unknown> }[]>`
					SELECT to_jsonb(document) - 'embedding_status' - 'embedding_error_code' AS preserved
					FROM public.documents AS document
					WHERE id = ${documentId}::uuid`;

				const result = await drainMetadataReembedOutbox(
					snapshot.operationId,
					10,
				);
				expect(result).toEqual({ enqueued: 1, completed: 1, failed: 0 });
				const [after] = await setup<
					{
						preserved: Record<string, unknown>;
						embedding_status: string;
						embedding_error_code: string | null;
					}[]
				>`
					SELECT
						to_jsonb(document) - 'embedding_status' - 'embedding_error_code' AS preserved,
						embedding_status,
						embedding_error_code
					FROM public.documents AS document
					WHERE id = ${documentId}::uuid`;
				expect(after?.preserved).toEqual(before?.preserved);
				expect(after?.embedding_status).toBe("stale");
				expect(after?.embedding_error_code).toBeNull();
			} finally {
				if (generationId) {
					const job = await queue.getJob(
						JOB_IDS.prepare(documentId, generationId),
					);
					await job?.remove();
				}
				await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
				await Promise.all([setup.end(), snapshotClient.client.end()]);
			}
		});

		test("acknowledges a completed exact generation without changing the document", async () => {
			const setup = postgres(databaseUrl as string, { max: 1 });
			const snapshotClient = createDatabaseClient(databaseUrl as string, {
				max: 1,
			});
			const ownerId = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const revision = contentHash("terminal", "body");
			const context: TenantContext = {
				userId: ownerId,
				role: "user",
				source: "personal",
			};
			const queue = getPipelineQueue("prepare", config.REDIS_URL);
			let generationId: string | undefined;

			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES (${ownerId}::uuid, ${`${ownerId}@metadata-terminal.invalid`})`;
				await setup`INSERT INTO public.documents
					(id, owner_id, title, content, content_hash, embedding_status, updated_at)
					VALUES (
						${documentId}::uuid,
						${ownerId}::uuid,
						'terminal',
						'body',
						${revision},
						'ready',
						'2024-06-02T12:34:56.123456Z'::timestamp
					)`;
				const snapshot = await withTenantDatabase(
					snapshotClient.db,
					context,
					(tx) => snapshotDocumentMetadataImpact(tx, context, documentId),
				);
				const [outbox] = await setup<{ id: string }[]>`
					SELECT id::text FROM public.metadata_reembed_outbox
					WHERE operation_id = ${snapshot.operationId}::uuid`;
				if (!outbox) throw new Error("terminal metadata outbox row missing");
				generationId = outbox.id;
				await setup`INSERT INTO public.document_pipeline_runs (
					document_id, owner_id, generation_id, revision, source, refresh_mode,
					status, prepare_status, embed_status, graph_status,
					summarize_status, finalize_status, completed_at
				) VALUES (
					${documentId}::uuid,
					${ownerId}::uuid,
					${generationId}::uuid,
					${revision},
					'interactive',
					'full',
					'ready', 'ready', 'ready', 'ready', 'ready', 'ready', now()
				)`;
				await setup`UPDATE public.documents
					SET active_embedding_generation = ${generationId}::uuid
					WHERE id = ${documentId}::uuid`;
				const [before] = await setup<{ document: Record<string, unknown> }[]>`
					SELECT to_jsonb(document) AS document
					FROM public.documents AS document
					WHERE id = ${documentId}::uuid`;

				const result = await drainMetadataReembedOutbox(
					snapshot.operationId,
					10,
				);
				expect(result).toEqual({ enqueued: 0, completed: 1, failed: 0 });
				const [after] = await setup<{ document: Record<string, unknown> }[]>`
					SELECT to_jsonb(document) AS document
					FROM public.documents AS document
					WHERE id = ${documentId}::uuid`;
				expect(after?.document).toEqual(before?.document);
				const [remaining] = await setup<{ count: number }[]>`
					SELECT count(*)::int AS count FROM public.metadata_reembed_outbox
					WHERE id = ${generationId}::uuid`;
				expect(remaining?.count).toBe(0);
				expect(
					await queue.getJob(JOB_IDS.prepare(documentId, generationId)),
				).toBeFalsy();
			} finally {
				if (generationId) {
					const job = await queue.getJob(
						JOB_IDS.prepare(documentId, generationId),
					);
					await job?.remove();
				}
				await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
				await Promise.all([setup.end(), snapshotClient.client.end()]);
			}
		});

		test("serializes bulk staging with run-first worker transactions without deadlock", async () => {
			const setup = postgres(databaseUrl as string, { max: 1 });
			const worker = postgres(databaseUrl as string, { max: 1 });
			const observer = postgres(databaseUrl as string, { max: 1 });
			const snapshotClient = createDatabaseClient(databaseUrl as string, {
				max: 1,
			});
			const ownerId = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const oldGenerationId = crypto.randomUUID();
			const revision = contentHash("deadlock", "body");
			const context: TenantContext = {
				userId: ownerId,
				role: "user",
				source: "personal",
			};
			const runLocked = deferred<void>();
			const releaseWorkerDocument = deferred<void>();
			const queue = getPipelineQueue("prepare", config.REDIS_URL);
			let workerPid = 0;
			let generationId: string | undefined;

			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES (${ownerId}::uuid, ${`${ownerId}@metadata-deadlock.invalid`})`;
				await setup`INSERT INTO public.documents
					(id, owner_id, title, content, content_hash, embedding_status)
					VALUES (
						${documentId}::uuid,
						${ownerId}::uuid,
						'deadlock',
						'body',
						${revision},
						'pending'
					)`;
				await setup`INSERT INTO public.document_pipeline_runs
					(document_id, owner_id, generation_id, revision, source, requested_at)
					VALUES (
						${documentId}::uuid,
						${ownerId}::uuid,
						${oldGenerationId}::uuid,
						${revision},
						'interactive',
						now() - interval '1 minute'
					)`;
				const snapshot = await withTenantDatabase(
					snapshotClient.db,
					context,
					(tx) => snapshotDocumentMetadataImpact(tx, context, documentId),
				);
				const [outbox] = await setup<{ id: string }[]>`
					SELECT id::text FROM public.metadata_reembed_outbox
					WHERE operation_id = ${snapshot.operationId}::uuid`;
				if (!outbox) throw new Error("deadlock metadata outbox row missing");
				generationId = outbox.id;

				const workerTask = worker.begin(async (tx) => {
					await tx`SET LOCAL deadlock_timeout = '100ms'`;
					await tx`SET LOCAL lock_timeout = '3s'`;
					const [pid] = await tx<{ pid: number }[]>`
						SELECT pg_backend_pid() AS pid`;
					workerPid = pid?.pid ?? 0;
					await tx`SELECT pg_advisory_xact_lock(
						${expectedDocumentPipelineLockKey(documentId).toString()}::bigint
					)`;
					await tx`SELECT id FROM public.document_pipeline_runs
						WHERE generation_id = ${oldGenerationId}::uuid
						FOR UPDATE`;
					runLocked.resolve();
					await releaseWorkerDocument.promise;
					await tx`UPDATE public.documents
						SET embedding_status = 'processing'
						WHERE id = ${documentId}::uuid`;
				});
				await runLocked.promise;
				if (!workerPid) throw new Error("worker backend PID missing");
				const drainTask = drainMetadataReembedOutbox(snapshot.operationId, 10);
				await waitForSessionBlockedBy(observer, workerPid);
				releaseWorkerDocument.resolve();
				const [workerResult, drainResult] = await Promise.allSettled([
					workerTask,
					drainTask,
				]);
				expect(workerResult.status).toBe("fulfilled");
				expect(drainResult).toEqual({
					status: "fulfilled",
					value: { enqueued: 1, completed: 1, failed: 0 },
				});
				const runs = await setup<
					{ generation_id: string; status: string }[]
				>`SELECT generation_id::text, status
					FROM public.document_pipeline_runs
					WHERE document_id = ${documentId}::uuid
					ORDER BY generation_id`;
				const statuses = new Map(
					runs.map(({ generation_id, status }) => [generation_id, status]),
				);
				expect(statuses.get(oldGenerationId)).toBe("cancelled");
				expect(statuses.get(generationId)).toBe("pending");
				const [document] = await setup<{ embedding_status: string }[]>`
					SELECT embedding_status FROM public.documents
					WHERE id = ${documentId}::uuid`;
				expect(document?.embedding_status).toBe("stale");
			} finally {
				releaseWorkerDocument.resolve();
				if (generationId) {
					const job = await queue.getJob(
						JOB_IDS.prepare(documentId, generationId),
					);
					await job?.remove();
				}
				await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
				await Promise.all([
					setup.end(),
					worker.end(),
					observer.end(),
					snapshotClient.client.end(),
				]);
			}
		});

		test("serializes hard purge before its document-to-pipeline cascade", async () => {
			const setup = postgres(databaseUrl as string, { max: 1 });
			const worker = postgres(databaseUrl as string, { max: 1 });
			const observer = postgres(databaseUrl as string, { max: 1 });
			const documentId = crypto.randomUUID();
			const generationId = crypto.randomUUID();
			const workerReady = deferred<number>();
			const releaseWorker = deferred<void>();
			const app = new Elysia().use(documentRoutes);
			let workerTransaction: Promise<unknown> | undefined;
			let purgeRequest: Promise<Response> | undefined;
			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES (${config.OWNER_ID}::uuid, ${`${config.OWNER_ID}@purge-lock.invalid`})
					ON CONFLICT (id) DO NOTHING`;
				await setup`INSERT INTO public.documents
					(id, owner_id, title, content, deleted_at)
					VALUES (
						${documentId}::uuid,
						${config.OWNER_ID}::uuid,
						'purge lock regression',
						'',
						now()
					)`;
				await setup`INSERT INTO public.document_pipeline_runs
					(document_id, owner_id, generation_id, revision, source)
					VALUES (
						${documentId}::uuid,
						${config.OWNER_ID}::uuid,
						${generationId}::uuid,
						'purge-lock-revision',
						'interactive'
					)`;

				workerTransaction = worker.begin(async (tx) => {
					const [session] = await tx<{ pid: number }[]>`
						SELECT pg_backend_pid() AS pid`;
					if (!session?.pid) throw new Error("worker session has no pid");
					await tx`SELECT pg_advisory_xact_lock(
						${expectedDocumentPipelineLockKey(documentId).toString()}::bigint
					)`;
					await tx`SELECT id
						FROM public.document_pipeline_runs
						WHERE document_id = ${documentId}::uuid
						FOR UPDATE`;
					workerReady.resolve(session.pid);
					await releaseWorker.promise;
					const locked = await tx<{ id: string }[]>`SELECT id::text
						FROM public.documents
						WHERE id = ${documentId}::uuid
						FOR UPDATE`;
					expect(locked[0]?.id).toBe(documentId);
				});
				const workerPid = await workerReady.promise;

				purgeRequest = app.handle(
					new Request(`http://localhost/api/trash/documents/${documentId}`, {
						method: "DELETE",
						headers: {
							authorization: `Bearer ${config.HIAI_DOCS_API_KEY}`,
							"x-forwarded-for": `purge-lock-${documentId}`,
						},
					}),
				);
				const purgePid = await Promise.race([
					waitForSessionBlockedBy(observer, workerPid),
					purgeRequest.then(async (response) => {
						throw new Error(
							`hard purge settled before the pipeline lock: ${response.status} ${await response.clone().text()}`,
						);
					}),
				]);
				const [blocked] = await observer<{ query: string }[]>`
					SELECT query
					FROM pg_stat_activity
					WHERE pid = ${purgePid}`;

				releaseWorker.resolve(undefined);
				const [workerResult, purgeResult] = await Promise.allSettled([
					workerTransaction,
					purgeRequest,
				]);
				expect(blocked?.query).toContain("docsmint:document-pipeline-lock");
				expect(workerResult.status).toBe("fulfilled");
				expect(purgeResult.status).toBe("fulfilled");
				if (purgeResult.status !== "fulfilled") throw purgeResult.reason;
				expect(purgeResult.value.status).toBe(200);
				expect(await purgeResult.value.json()).toEqual({ success: true });
				const remaining = await setup<{ documents: number; runs: number }[]>`
					SELECT
						(SELECT count(*)::int FROM public.documents
						 WHERE id = ${documentId}::uuid) AS documents,
						(SELECT count(*)::int FROM public.document_pipeline_runs
						 WHERE document_id = ${documentId}::uuid) AS runs`;
				expect(remaining[0]).toEqual({ documents: 0, runs: 0 });
			} finally {
				releaseWorker.resolve(undefined);
				await Promise.allSettled(
					[workerTransaction, purgeRequest].filter(
						(value): value is Promise<unknown> => value !== undefined,
					),
				);
				await setup`DELETE FROM public.document_pipeline_runs
					WHERE document_id = ${documentId}::uuid`;
				await setup`DELETE FROM public.documents WHERE id = ${documentId}::uuid`;
				await Promise.all([setup.end(), worker.end(), observer.end()]);
			}
		});

		test("rejects a foreign hard-purge target before acquiring its pipeline lock", async () => {
			const setup = postgres(databaseUrl as string, { max: 1 });
			const worker = postgres(databaseUrl as string, { max: 1 });
			const foreignOwnerId = crypto.randomUUID();
			const attackerId = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const rawKey = crypto.randomUUID();
			const keyHash = new Bun.CryptoHasher("sha256")
				.update(rawKey)
				.digest("hex");
			const workerReady = deferred<void>();
			const releaseWorker = deferred<void>();
			const app = new Elysia().use(documentRoutes);
			let workerTransaction: Promise<unknown> | undefined;
			let purgeRequest: Promise<Response> | undefined;
			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES
						(${foreignOwnerId}::uuid, ${`${foreignOwnerId}@foreign-purge.invalid`}),
						(${attackerId}::uuid, ${`${attackerId}@foreign-purge.invalid`})`;
				await setup`INSERT INTO public.api_keys
					(owner_id, name, key_hash, prefix, scopes)
					VALUES (
						${attackerId}::uuid,
						'foreign purge regression',
						${keyHash},
						${rawKey.slice(0, 8)},
						'["global"]'::jsonb
					)`;
				await setup`INSERT INTO public.documents
					(id, owner_id, title, content, deleted_at)
					VALUES (
						${documentId}::uuid,
						${foreignOwnerId}::uuid,
						'foreign purge regression',
						'',
						now()
					)`;

				workerTransaction = worker.begin(async (tx) => {
					await tx`SELECT pg_advisory_xact_lock(
						${expectedDocumentPipelineLockKey(documentId).toString()}::bigint
					)`;
					workerReady.resolve(undefined);
					await releaseWorker.promise;
				});
				await workerReady.promise;

				purgeRequest = app.handle(
					new Request(`http://localhost/api/trash/documents/${documentId}`, {
						method: "DELETE",
						headers: { authorization: `Bearer ${rawKey}` },
					}),
				);
				const settled = await Promise.race([
					purgeRequest.then((response) => ({ response })),
					Bun.sleep(2_000).then(() => ({ response: null })),
				]);
				expect(settled.response).not.toBeNull();
				expect(settled.response?.status).toBe(404);
				const [remaining] = await setup<{ count: number }[]>`
					SELECT count(*)::int AS count FROM public.documents
					WHERE id = ${documentId}::uuid`;
				expect(remaining?.count).toBe(1);
			} finally {
				releaseWorker.resolve(undefined);
				await Promise.allSettled(
					[workerTransaction, purgeRequest].filter(
						(value): value is Promise<unknown> => value !== undefined,
					),
				);
				await setup`DELETE FROM public.users
					WHERE id IN (${foreignOwnerId}::uuid, ${attackerId}::uuid)`;
				await Promise.all([setup.end(), worker.end()]);
			}
		});

		test("serializes lifecycle document purge before pipeline cascades", async () => {
			const setup = postgres(databaseUrl as string, { max: 1 });
			const worker = postgres(databaseUrl as string, { max: 1 });
			const observer = postgres(databaseUrl as string, { max: 1 });
			const lifecycleClient = createDatabaseClient(databaseUrl as string, {
				max: 2,
			});
			const ownerId = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const generationId = crypto.randomUUID();
			const workerReady = deferred<number>();
			const releaseWorker = deferred<void>();
			let workerTransaction: Promise<unknown> | undefined;
			let purgeOperation: Promise<unknown> | undefined;
			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES (${ownerId}::uuid, ${`${ownerId}@lifecycle-purge-lock.invalid`})`;
				await setup`INSERT INTO public.documents
					(id, owner_id, title, content, deleted_at)
					VALUES (
						${documentId}::uuid,
						${ownerId}::uuid,
						'lifecycle purge lock regression',
						'',
						now()
					)`;
				await setup`INSERT INTO public.document_pipeline_runs
					(document_id, owner_id, generation_id, revision, source)
					VALUES (
						${documentId}::uuid,
						${ownerId}::uuid,
						${generationId}::uuid,
						'lifecycle-purge-lock-revision',
						'interactive'
					)`;

				workerTransaction = worker.begin(async (tx) => {
					const [session] = await tx<{ pid: number }[]>`
						SELECT pg_backend_pid() AS pid`;
					if (!session?.pid) throw new Error("worker session has no pid");
					await tx`SELECT pg_advisory_xact_lock(
						${expectedDocumentPipelineLockKey(documentId).toString()}::bigint
					)`;
					await tx`SELECT id
						FROM public.document_pipeline_runs
						WHERE document_id = ${documentId}::uuid
						FOR UPDATE`;
					workerReady.resolve(session.pid);
					await releaseWorker.promise;
					const locked = await tx<{ id: string }[]>`SELECT id::text
						FROM public.documents
						WHERE id = ${documentId}::uuid
						FOR UPDATE`;
					expect(locked[0]?.id).toBe(documentId);
				});
				const workerPid = await workerReady.promise;

				const lifecycle = createPersistentLifecycleService(
					{
						verifyPurgeFence: async () => {},
						deleteObjects: async (keys) => keys.length,
						cancelAccountJobs: async () => 0,
						clearAccountRedisState: async () => 0,
						removeCollaborationState: async () => 0,
						removeGraphState: async (documentIds) => documentIds.length,
					},
					{
						withActorTransaction: (actorUserId, operation) =>
							withTenantDatabase(
								lifecycleClient.db,
								{
									userId: actorUserId,
									role: "user",
									source: "personal",
								},
								operation,
							),
					},
					[],
				);
				purgeOperation = lifecycle.purgeUserData(
					{
						actorUserId: ownerId,
						requestId: crypto.randomUUID(),
						idempotencyKey: `purge-lock-${crypto.randomUUID()}`,
						reason: "account_deletion",
					},
					{ fenceToken: "purge-lock-fence" },
				);
				const purgePid = await waitForSessionBlockedBy(observer, workerPid);
				const [blocked] = await observer<{ query: string }[]>`
					SELECT query
					FROM pg_stat_activity
					WHERE pid = ${purgePid}`;

				releaseWorker.resolve(undefined);
				const [workerResult, purgeResult] = await Promise.allSettled([
					workerTransaction,
					purgeOperation,
				]);
				expect(blocked?.query).toContain("docsmint:document-pipeline-lock");
				expect(workerResult.status).toBe("fulfilled");
				expect(purgeResult.status).toBe("fulfilled");
				if (purgeResult.status !== "fulfilled") throw purgeResult.reason;
				expect(purgeResult.value).toMatchObject({ status: "completed" });
				const remaining = await setup<{ documents: number; runs: number }[]>`
					SELECT
						(SELECT count(*)::int FROM public.documents
						 WHERE id = ${documentId}::uuid) AS documents,
						(SELECT count(*)::int FROM public.document_pipeline_runs
						 WHERE document_id = ${documentId}::uuid) AS runs`;
				expect(remaining[0]).toEqual({ documents: 0, runs: 0 });
			} finally {
				releaseWorker.resolve(undefined);
				await Promise.allSettled(
					[workerTransaction, purgeOperation].filter(
						(value): value is Promise<unknown> => value !== undefined,
					),
				);
				await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
				await Promise.all([
					setup.end(),
					worker.end(),
					observer.end(),
					lifecycleClient.client.end(),
				]);
			}
		});

		test("fences personal, workspace, and worker writes until lifecycle final deletion and tombstone", async () => {
			const setup = postgres(databaseUrl as string, { max: 1 });
			const lifecycleClient = createDatabaseClient(databaseUrl as string, {
				max: 2,
			});
			const ownerId = crypto.randomUUID();
			const peerOwnerId = crypto.randomUUID();
			const workspaceId = `purge-fence-${crypto.randomUUID()}`;
			const categoryId = crypto.randomUUID();
			const folderId = crypto.randomUUID();
			const originalDocumentId = crypto.randomUUID();
			const trashedDocumentId = crypto.randomUUID();
			const versionId = crypto.randomUUID();
			const rawKey = crypto.randomUUID();
			const keyHash = new Bun.CryptoHasher("sha256")
				.update(rawKey)
				.digest("hex");
			const graphRemovalEntered = deferred<void>();
			const releaseGraphRemoval = deferred<void>();
			const app = new Elysia().use(documentRoutes);
			let purgeOperation: Promise<unknown> | undefined;
			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES
						(${ownerId}::uuid, ${`${ownerId}@lifecycle-create-fence.invalid`}),
						(${peerOwnerId}::uuid, ${`${peerOwnerId}@lifecycle-create-fence.invalid`})`;
				await setup`INSERT INTO public.api_keys
					(owner_id, name, key_hash, prefix, scopes)
					VALUES (
						${ownerId}::uuid,
						'lifecycle create fence regression',
						${keyHash},
						${rawKey.slice(0, 8)},
						'["global"]'::jsonb
					)`;
				await setup`INSERT INTO public.categories (id, owner_id, name)
					VALUES (${categoryId}::uuid, ${ownerId}::uuid, 'purge category')`;
				await setup`INSERT INTO public.folders
					(id, owner_id, category_id, name)
					VALUES (
						${folderId}::uuid,
						${ownerId}::uuid,
						${categoryId}::uuid,
						'purge folder'
					)`;
				await setup`INSERT INTO public.documents
					(id, owner_id, folder_id, category_id, title, content, deleted_at)
					VALUES
						(
							${originalDocumentId}::uuid,
							${ownerId}::uuid,
							${folderId}::uuid,
							${categoryId}::uuid,
							'pre-fence document',
							'',
							NULL
						),
						(
							${trashedDocumentId}::uuid,
							${ownerId}::uuid,
							NULL,
							NULL,
							'pre-fence trashed document',
							'',
							now()
						)`;
				await setup`INSERT INTO public.versions
					(id, document_id, content, created_by)
					VALUES (
						${versionId}::uuid,
						${originalDocumentId}::uuid,
						'prior version',
						${ownerId}::uuid
					)`;

				const lifecycle = createPersistentLifecycleService(
					{
						verifyPurgeFence: async () => {},
						deleteObjects: async (keys) => keys.length,
						cancelAccountJobs: async () => 0,
						clearAccountRedisState: async () => 0,
						removeCollaborationState: async () => 0,
						removeGraphState: async (documentIds) => {
							graphRemovalEntered.resolve(undefined);
							await releaseGraphRemoval.promise;
							return documentIds.length;
						},
					},
					{
						withActorTransaction: (actorUserId, operation) =>
							withTenantDatabase(
								lifecycleClient.db,
								{
									userId: actorUserId,
									role: "user",
									source: "personal",
								},
								operation,
							),
					},
					[],
				);
				purgeOperation = lifecycle.purgeUserData(
					{
						actorUserId: ownerId,
						requestId: crypto.randomUUID(),
						idempotencyKey: `purge-create-fence-${crypto.randomUUID()}`,
						reason: "account_deletion",
					},
					{ fenceToken: "purge-create-fence" },
				);
				await graphRemovalEntered.promise;

				const createResponse = await app.handle(
					new Request("http://localhost/api/documents", {
						method: "POST",
						headers: {
							authorization: `Bearer ${rawKey}`,
							"content-type": "application/json",
						},
						body: JSON.stringify({
							title: "late purge race document",
							content: "must never survive account purge",
						}),
					}),
				);
				expect(createResponse.status).toBe(409);
				expect(await createResponse.json()).toEqual({
					error: "Account deletion is in progress",
					code: "ACCOUNT_PURGE_FENCED",
				});
				const guardedRequests = [
					{
						name: "duplicate",
						app,
						request: new Request(
							`http://localhost/api/documents/${originalDocumentId}/duplicate`,
							{
								method: "POST",
								headers: { authorization: `Bearer ${rawKey}` },
							},
						),
					},
					{
						name: "import",
						app,
						request: new Request("http://localhost/api/documents/import", {
							method: "POST",
							headers: {
								authorization: `Bearer ${rawKey}`,
								"content-type": "application/json",
							},
							body: JSON.stringify({
								title: "fenced import",
								content: "blocked",
							}),
						}),
					},
					{
						name: "trash restore",
						app,
						request: new Request(
							`http://localhost/api/trash/documents/${trashedDocumentId}/restore`,
							{
								method: "POST",
								headers: { authorization: `Bearer ${rawKey}` },
							},
						),
					},
				];
				for (const guarded of guardedRequests) {
					const response = await guarded.app.handle(guarded.request);
					expect({ name: guarded.name, status: response.status }).toEqual({
						name: guarded.name,
						status: 409,
					});
					expect(await response.json()).toEqual({
						error: "Account deletion is in progress",
						code: "ACCOUNT_PURGE_FENCED",
					});
				}
				let workspaceWriteError: unknown;
				try {
					await setup`INSERT INTO public.documents
						(owner_id, workspace_id, title, content)
						VALUES (
							${ownerId}::uuid,
							${workspaceId},
							'fenced owner workspace document',
							''
						)`;
				} catch (error) {
					workspaceWriteError = error;
				}
				expect((workspaceWriteError as Error).message).toContain(
					"account_purge_fenced",
				);
				let ownershipEscapeError: unknown;
				try {
					await setup`UPDATE public.documents
						SET owner_id = ${peerOwnerId}::uuid,
							workspace_id = ${workspaceId}
						WHERE id = ${originalDocumentId}::uuid`;
				} catch (error) {
					ownershipEscapeError = error;
				}
				expect((ownershipEscapeError as Error).message).toContain(
					"account_purge_fenced",
				);

				const [peerDocument] = await setup<{ id: string }[]>`
					INSERT INTO public.documents
						(owner_id, workspace_id, title, content)
					VALUES (
						${peerOwnerId}::uuid,
						${workspaceId},
						'peer workspace document remains admitted',
						''
					)
					RETURNING id::text`;
				let workerWriteError: unknown;
				try {
					await setup`INSERT INTO public.document_pipeline_runs
						(document_id, owner_id, generation_id, revision, source)
						VALUES (
							${originalDocumentId}::uuid,
							${ownerId}::uuid,
							${crypto.randomUUID()}::uuid,
							'worker-after-fence',
							'interactive'
						)`;
				} catch (error) {
					workerWriteError = error;
				}
				expect((workerWriteError as Error).message).toContain(
					"account_purge_fenced",
				);

				releaseGraphRemoval.resolve(undefined);
				const purgeResult = await purgeOperation;
				expect(purgeResult).toMatchObject({ status: "completed" });
				const [state] = await setup<
					{
						documents: number;
						folders: number;
						categories: number;
						sessions: number;
						accountKeys: number;
						email: string;
					}[]
				>`SELECT
						(SELECT count(*)::int FROM public.documents WHERE owner_id = ${ownerId}::uuid) AS documents,
						(SELECT count(*)::int FROM public.folders WHERE owner_id = ${ownerId}::uuid) AS folders,
						(SELECT count(*)::int FROM public.categories WHERE owner_id = ${ownerId}::uuid) AS categories,
						(SELECT count(*)::int FROM public.sessions WHERE user_id = ${ownerId}::uuid) AS sessions,
						(SELECT count(*)::int FROM public.api_keys WHERE owner_id = ${ownerId}::uuid) AS "accountKeys",
						email
					FROM public.users WHERE id = ${ownerId}::uuid`;
				expect(state).toMatchObject({
					documents: 0,
					folders: 0,
					categories: 0,
					sessions: 0,
					accountKeys: 0,
				});
				expect(state?.email).toMatch(/^deleted-[a-f0-9]{64}@invalid\.local$/);
				const [peerState] = await setup<{ count: number }[]>`
					SELECT count(*)::int AS count FROM public.documents
					WHERE id = ${peerDocument?.id ?? crypto.randomUUID()}::uuid`;
				expect(peerState?.count).toBe(1);

				let completedFenceError: unknown;
				try {
					await setup`INSERT INTO public.sessions
						(user_id, token, expires_at)
						VALUES (
							${ownerId}::uuid,
							${crypto.randomUUID()},
							now() + interval '1 hour'
						)`;
				} catch (error) {
					completedFenceError = error;
				}
				expect(completedFenceError).toBeInstanceOf(Error);
				expect((completedFenceError as Error).message).toContain(
					"account_purge_fenced",
				);
			} finally {
				releaseGraphRemoval.resolve(undefined);
				await Promise.allSettled(
					[purgeOperation].filter(
						(value): value is Promise<unknown> => value !== undefined,
					),
				);
				await setup`DELETE FROM public.users
					WHERE id IN (${ownerId}::uuid, ${peerOwnerId}::uuid)`;
				await Promise.all([setup.end(), lifecycleClient.client.end()]);
			}
		}, 30_000);

		test("serializes a pre-fence direct create before the lifecycle snapshot", async () => {
			const setup = postgres(databaseUrl as string, { max: 1 });
			const creator = postgres(databaseUrl as string, { max: 1 });
			const observer = postgres(databaseUrl as string, { max: 1 });
			const applicationName = `lifecycle-fence-${crypto.randomUUID()}`;
			const lifecycleUrl = new URL(databaseUrl as string);
			lifecycleUrl.searchParams.set("application_name", applicationName);
			const lifecycleClient = createDatabaseClient(lifecycleUrl.toString(), {
				max: 2,
			});
			const ownerId = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const creatorReady = deferred<number>();
			const releaseCreator = deferred<void>();
			const cancelEntered = deferred<void>();
			const releaseCancel = deferred<void>();
			let creatorTransaction: Promise<unknown> | undefined;
			let purgeOperation: Promise<unknown> | undefined;
			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES (${ownerId}::uuid, ${`${ownerId}@pre-fence-create.invalid`})`;
				creatorTransaction = creator.begin(async (tx) => {
					const [session] = await tx<{ pid: number }[]>`
						SELECT pg_backend_pid() AS pid`;
					await tx`INSERT INTO public.documents (id, owner_id, title, content)
						VALUES (
							${documentId}::uuid,
							${ownerId}::uuid,
							'commits before lifecycle fence',
							''
						)`;
					creatorReady.resolve(session?.pid ?? 0);
					await releaseCreator.promise;
				});
				const creatorPid = await creatorReady.promise;
				if (!creatorPid) throw new Error("creator backend PID missing");

				const lifecycle = createPersistentLifecycleService(
					{
						verifyPurgeFence: async () => {},
						deleteObjects: async (keys) => keys.length,
						cancelAccountJobs: async () => {
							cancelEntered.resolve(undefined);
							await releaseCancel.promise;
							return 0;
						},
						clearAccountRedisState: async () => 0,
						removeCollaborationState: async () => 0,
						removeGraphState: async (ids) => ids.length,
					},
					{
						withActorTransaction: (actorUserId, operation) =>
							withTenantDatabase(
								lifecycleClient.db,
								{
									userId: actorUserId,
									role: "user",
									source: "personal",
								},
								operation,
							),
					},
					[],
				);
				purgeOperation = lifecycle.purgeUserData(
					{
						actorUserId: ownerId,
						requestId: crypto.randomUUID(),
						idempotencyKey: `pre-fence-create-${crypto.randomUUID()}`,
						reason: "account_deletion",
					},
					{ fenceToken: "pre-fence-create" },
				);
				await waitForApplicationBlockedBy(
					observer,
					creatorPid,
					applicationName,
				);
				releaseCreator.resolve(undefined);
				await creatorTransaction;
				await cancelEntered.promise;
				releaseCancel.resolve(undefined);
				expect(await purgeOperation).toMatchObject({ status: "completed" });
				const [remaining] = await setup<{ count: number }[]>`
					SELECT count(*)::int AS count FROM public.documents
					WHERE id = ${documentId}::uuid`;
				expect(remaining?.count).toBe(0);
			} finally {
				releaseCreator.resolve(undefined);
				releaseCancel.resolve(undefined);
				await Promise.allSettled(
					[creatorTransaction, purgeOperation].filter(
						(value): value is Promise<unknown> => value !== undefined,
					),
				);
				await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
				await Promise.all([
					setup.end(),
					creator.end(),
					observer.end(),
					lifecycleClient.client.end(),
				]);
			}
		}, 30_000);

		test("keeps a rejected host fence unfenced and a retryable local fence closed", async () => {
			const setup = postgres(databaseUrl as string, { max: 1 });
			const lifecycleClient = createDatabaseClient(databaseUrl as string, {
				max: 2,
			});
			const rejectedOwnerId = crypto.randomUUID();
			const retryOwnerId = crypto.randomUUID();
			const retryDocumentId = crypto.randomUUID();
			const retryVersionId = crypto.randomUUID();
			const retryRawKey = crypto.randomUUID();
			const retryKeyHash = new Bun.CryptoHasher("sha256")
				.update(retryRawKey)
				.digest("hex");
			const versionApp = new Elysia().use(versionRoutes);
			const executor = {
				withActorTransaction<T>(
					actorUserId: string,
					operation: (tx: TenantTransaction) => Promise<T>,
				): Promise<T> {
					return withTenantDatabase(
						lifecycleClient.db,
						{ userId: actorUserId, role: "user", source: "personal" },
						operation,
					);
				},
			};
			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES
						(${rejectedOwnerId}::uuid, ${`${rejectedOwnerId}@rejected-fence.invalid`}),
						(${retryOwnerId}::uuid, ${`${retryOwnerId}@retry-fence.invalid`})`;
				await setup`INSERT INTO public.api_keys
					(owner_id, name, key_hash, prefix, scopes)
					VALUES (
						${retryOwnerId}::uuid,
						'retry fence version restore',
						${retryKeyHash},
						${retryRawKey.slice(0, 8)},
						'["global"]'::jsonb
					)`;
				await setup`INSERT INTO public.documents (id, owner_id, title, content)
					VALUES (${retryDocumentId}::uuid, ${retryOwnerId}::uuid, 'retry document', 'current')`;
				await setup`INSERT INTO public.versions
					(id, document_id, content, created_by)
					VALUES (
						${retryVersionId}::uuid,
						${retryDocumentId}::uuid,
						'prior',
						${retryOwnerId}::uuid
					)`;
				const rejectedLifecycle = createPersistentLifecycleService(
					{
						verifyPurgeFence: async () => {
							throw new LifecycleFenceRejectedError();
						},
						deleteObjects: async () => 0,
						cancelAccountJobs: async () => 0,
						clearAccountRedisState: async () => 0,
						removeCollaborationState: async () => 0,
						removeGraphState: async () => 0,
					},
					executor,
					[],
				);
				let rejectedError: unknown;
				try {
					await rejectedLifecycle.purgeUserData(
						{
							actorUserId: rejectedOwnerId,
							requestId: crypto.randomUUID(),
							idempotencyKey: `rejected-${crypto.randomUUID()}`,
							reason: "account_deletion",
						},
						{ fenceToken: "rejected" },
					);
				} catch (error) {
					rejectedError = error;
				}
				expect(rejectedError).toBeInstanceOf(LifecycleFenceRejectedError);
				await setup`INSERT INTO public.documents (owner_id, title, content)
					VALUES (${rejectedOwnerId}::uuid, 'rejected remains writable', '')`;

				let failFirstAttempt = true;
				const retryLifecycle = createPersistentLifecycleService(
					{
						verifyPurgeFence: async () => {},
						deleteObjects: async () => 0,
						cancelAccountJobs: async () => {
							if (failFirstAttempt) {
								failFirstAttempt = false;
								throw new Error("transient cancellation failure");
							}
							return 0;
						},
						clearAccountRedisState: async () => 0,
						removeCollaborationState: async () => 0,
						removeGraphState: async () => 0,
					},
					executor,
					[],
				);
				const retryContext = {
					actorUserId: retryOwnerId,
					requestId: crypto.randomUUID(),
					idempotencyKey: `retry-${crypto.randomUUID()}`,
					reason: "account_deletion" as const,
				};
				await expect(
					retryLifecycle.purgeUserData(retryContext, {
						fenceToken: "retry-fence",
					}),
				).rejects.toThrow("transient cancellation failure");
				let retryWriteError: unknown;
				try {
					await setup`INSERT INTO public.documents (owner_id, title, content)
						VALUES (${retryOwnerId}::uuid, 'retryable must remain fenced', '')`;
				} catch (error) {
					retryWriteError = error;
				}
				expect((retryWriteError as Error).message).toContain(
					"account_purge_fenced",
				);
				const restoreResponse = await versionApp.handle(
					new Request(
						`http://localhost/api/documents/${retryDocumentId}/versions/${retryVersionId}/restore`,
						{
							method: "POST",
							headers: { authorization: `Bearer ${retryRawKey}` },
						},
					),
				);
				expect(restoreResponse.status).toBe(409);
				expect(await restoreResponse.json()).toEqual({
					error: "Account deletion is in progress",
					code: "ACCOUNT_PURGE_FENCED",
				});
				expect(
					await retryLifecycle.purgeUserData(retryContext, {
						fenceToken: "retry-fence",
					}),
				).toMatchObject({ status: "completed" });
			} finally {
				await setup`DELETE FROM public.users
					WHERE id IN (${rejectedOwnerId}::uuid, ${retryOwnerId}::uuid)`;
				await Promise.all([setup.end(), lifecycleClient.client.end()]);
			}
		}, 30_000);

		test("benchmark reset acquires one globally ordered document lock union across aliases", async () => {
			const setup = postgres(databaseUrl as string, { max: 1 });
			const worker = postgres(databaseUrl as string, { max: 1 });
			const observer = postgres(databaseUrl as string, { max: 1 });
			const ownerA = crypto.randomUUID();
			const ownerB = crypto.randomUUID();
			let highDocumentId = crypto.randomUUID();
			let lowDocumentId = crypto.randomUUID();
			while (
				expectedDocumentPipelineLockKey(highDocumentId) <=
				expectedDocumentPipelineLockKey(lowDocumentId)
			) {
				highDocumentId = crypto.randomUUID();
				lowDocumentId = crypto.randomUUID();
			}
			const highKey = expectedDocumentPipelineLockKey(highDocumentId);
			const lowKey = expectedDocumentPipelineLockKey(lowDocumentId);
			const applicationName = `benchmark-lock-${crypto.randomUUID()}`;
			const scriptDatabaseUrl = new URL(databaseUrl as string);
			scriptDatabaseUrl.searchParams.set("application_name", applicationName);
			const outputDir = `/tmp/docsmint-benchmark-lock-${crypto.randomUUID()}`;
			const workerReady = deferred<number>();
			const releaseWorker = deferred<void>();
			let workerTransaction: Promise<unknown> | undefined;
			let benchmarkProcess: ReturnType<typeof Bun.spawn> | undefined;
			try {
				await setup`DELETE FROM public.users
					WHERE email IN (
						'benchmark-owner-a@local.invalid',
						'benchmark-owner-b@local.invalid'
					)`;
				await setup`INSERT INTO public.users (id, email)
					VALUES
						(${ownerA}::uuid, 'benchmark-owner-a@local.invalid'),
						(${ownerB}::uuid, 'benchmark-owner-b@local.invalid')`;
				await setup`INSERT INTO public.documents (id, owner_id, title, content)
					VALUES
						(${highDocumentId}::uuid, ${ownerA}::uuid, 'alias high lock', ''),
						(${lowDocumentId}::uuid, ${ownerB}::uuid, 'alias low lock', '')`;

				workerTransaction = worker.begin(async (tx) => {
					const [session] = await tx<{ pid: number }[]>`
						SELECT pg_backend_pid() AS pid`;
					if (!session?.pid) throw new Error("worker session has no pid");
					await tx`SELECT pg_advisory_xact_lock(${lowKey.toString()}::bigint)`;
					workerReady.resolve(session.pid);
					await releaseWorker.promise;
					const [locked] = await tx<{ acquired: boolean }[]>`
						SELECT pg_try_advisory_xact_lock(${highKey.toString()}::bigint) AS acquired`;
					expect(locked?.acquired).toBe(true);
				});
				const workerPid = await workerReady.promise;

				benchmarkProcess = Bun.spawn(
					[
						"bun",
						"backend/src/scripts/seed-benchmark-search.ts",
						`--output-dir=${outputDir}`,
						"--reset",
					],
					{
						cwd: process.cwd(),
						env: {
							...Bun.env,
							DATABASE_URL: scriptDatabaseUrl.toString(),
						},
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				await waitForApplicationBlockedBy(observer, workerPid, applicationName);
				releaseWorker.resolve(undefined);
				const workerResult = await workerTransaction;
				expect(workerResult).toBeUndefined();
				const exitCode = await benchmarkProcess.exited;
				if (exitCode !== 0) {
					const stderr = benchmarkProcess.stderr;
					throw new Error(
						`benchmark seed failed: ${
							typeof stderr === "number" || stderr === undefined
								? "no stderr"
								: await new Response(stderr).text()
						}`,
					);
				}
				expect(exitCode).toBe(0);
			} finally {
				releaseWorker.resolve(undefined);
				benchmarkProcess?.kill();
				await Promise.allSettled(
					[workerTransaction, benchmarkProcess?.exited].filter(
						(value): value is Promise<unknown> => value !== undefined,
					),
				);
				await setup`DELETE FROM public.users
					WHERE email IN (
						'benchmark-owner-a@local.invalid',
						'benchmark-owner-b@local.invalid'
					)`;
				await Promise.all([setup.end(), worker.end(), observer.end()]);
			}
		}, 30_000);

		test("admits two rapid metadata events with unchanged content as distinct generations", async () => {
			const setup = postgres(databaseUrl as string, { max: 1 });
			const snapshotClient = createDatabaseClient(databaseUrl as string, {
				max: 1,
			});
			const ownerId = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const context: TenantContext = {
				userId: ownerId,
				role: "user",
				source: "personal",
			};
			const generationIds: string[] = [];
			const operationIds: string[] = [];
			const queue = getPipelineQueue("prepare", config.REDIS_URL);
			const queueTarget = queue as unknown as {
				addBulk: (jobs: unknown[]) => Promise<unknown[]>;
			};
			const originalAddBulk = queueTarget.addBulk.bind(queue);
			const firstBulkEntered = deferred<void>();
			const releaseFirstBulk = deferred<void>();
			let bulkCalls = 0;

			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES (${ownerId}::uuid, ${`${ownerId}@metadata-events.invalid`})`;
				await setup`INSERT INTO public.documents (id, owner_id, title, content)
					VALUES (${documentId}::uuid, ${ownerId}::uuid, 'same', 'body')`;

				for (const metadataName of ["first", "second"]) {
					const snapshot = await withTenantDatabase(
						snapshotClient.db,
						context,
						async (tx) => {
							await tx.execute(sql`UPDATE public.documents
								SET metadata = jsonb_build_object('event', ${metadataName}::text)
								WHERE id = ${documentId}::uuid`);
							return snapshotDocumentMetadataImpact(tx, context, documentId);
						},
					);
					const [outbox] = await setup<{ id: string }[]>`
						SELECT id::text FROM public.metadata_reembed_outbox
						WHERE operation_id = ${snapshot.operationId}::uuid`;
					if (!outbox) throw new Error("metadata event outbox row missing");
					generationIds.push(outbox.id);
					operationIds.push(snapshot.operationId);
				}
				queueTarget.addBulk = async (jobs: unknown[]) => {
					bulkCalls += 1;
					if (bulkCalls === 1) {
						firstBulkEntered.resolve();
						await releaseFirstBulk.promise;
					}
					return originalAddBulk(jobs);
				};
				const firstDrain = drainMetadataReembedOutbox(operationIds[0], 10);
				await firstBulkEntered.promise;
				await drainMetadataReembedOutbox(operationIds[1], 10);
				releaseFirstBulk.resolve();
				await firstDrain;

				const runs = await setup<
					{ generation_id: string; revision: string; status: string }[]
				>`
					SELECT generation_id::text, revision, status
					FROM public.document_pipeline_runs
					WHERE document_id = ${documentId}::uuid
					ORDER BY requested_at, generation_id`;
				expect(generationIds[0]).not.toBe(generationIds[1]);
				expect(runs.map(({ generation_id }) => generation_id).sort()).toEqual(
					[...generationIds].sort(),
				);
				expect(new Set(runs.map(({ revision }) => revision))).toEqual(
					new Set([runs[0]?.revision as string]),
				);
				const statuses = new Map(
					runs.map(({ generation_id, status }) => [generation_id, status]),
				);
				expect(statuses.get(generationIds[0] as string)).toBe("cancelled");
				expect(statuses.get(generationIds[1] as string)).toBe("pending");

				const queue = getPipelineQueue("prepare", config.REDIS_URL);
				const jobs = await Promise.all(
					generationIds.map((generationId) =>
						queue.getJob(JOB_IDS.prepare(documentId, generationId)),
					),
				);
				expect(jobs.every(Boolean)).toBe(true);
				expect(bulkCalls).toBe(2);
			} finally {
				releaseFirstBulk.resolve();
				queueTarget.addBulk = originalAddBulk;
				await Promise.allSettled(
					generationIds.map(async (generationId) => {
						const job = await queue.getJob(
							JOB_IDS.prepare(documentId, generationId),
						);
						await job?.remove();
					}),
				);
				await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
				await Promise.all([setup.end(), snapshotClient.client.end()]);
			}
		});

		test("retains a failed bulk admission and retries the same outbox generation", async () => {
			const setup = postgres(databaseUrl as string, { max: 1 });
			const snapshotClient = createDatabaseClient(databaseUrl as string, {
				max: 1,
			});
			const ownerId = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const context: TenantContext = {
				userId: ownerId,
				role: "user",
				source: "personal",
			};
			const queue = getPipelineQueue("prepare", config.REDIS_URL);
			const queueTarget = queue as unknown as {
				addBulk: (jobs: unknown[]) => Promise<unknown[]>;
			};
			const originalAddBulk = queueTarget.addBulk.bind(queue);
			let generationId: string | undefined;

			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES (${ownerId}::uuid, ${`${ownerId}@metadata-retry.invalid`})`;
				await setup`INSERT INTO public.documents (id, owner_id, title, content)
					VALUES (${documentId}::uuid, ${ownerId}::uuid, 'retry', 'body')`;
				const snapshot = await withTenantDatabase(
					snapshotClient.db,
					context,
					(tx) => snapshotDocumentMetadataImpact(tx, context, documentId),
				);
				const [outbox] = await setup<{ id: string }[]>`
					SELECT id::text FROM public.metadata_reembed_outbox
					WHERE operation_id = ${snapshot.operationId}::uuid`;
				if (!outbox) throw new Error("metadata retry outbox row missing");
				generationId = outbox.id;

				queueTarget.addBulk = async () => {
					throw new Error("simulated Redis admission failure");
				};
				const failed = await drainMetadataReembedOutbox(
					snapshot.operationId,
					10,
				);
				expect(failed).toEqual({ enqueued: 0, completed: 0, failed: 1 });
				const [retained] = await setup<{ count: number }[]>`
					SELECT count(*)::int AS count FROM public.metadata_reembed_outbox
					WHERE id = ${generationId}::uuid`;
				expect(retained?.count).toBe(1);

				queueTarget.addBulk = originalAddBulk;
				const recovered = await drainMetadataReembedOutbox(
					snapshot.operationId,
					10,
				);
				expect(recovered).toEqual({ enqueued: 1, completed: 1, failed: 0 });
				const runs = await setup<{ generation_id: string }[]>`
					SELECT generation_id::text FROM public.document_pipeline_runs
					WHERE document_id = ${documentId}::uuid`;
				expect(runs.map(({ generation_id }) => ({ generation_id }))).toEqual([
					{ generation_id: generationId },
				]);
				const [remaining] = await setup<{ count: number }[]>`
					SELECT count(*)::int AS count FROM public.metadata_reembed_outbox
					WHERE id = ${generationId}::uuid`;
				expect(remaining?.count).toBe(0);
				expect(
					await queue.getJob(JOB_IDS.prepare(documentId, generationId)),
				).toBeTruthy();
			} finally {
				queueTarget.addBulk = originalAddBulk;
				if (generationId) {
					const job = await queue.getJob(
						JOB_IDS.prepare(documentId, generationId),
					);
					await job?.remove();
				}
				await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
				await Promise.all([setup.end(), snapshotClient.client.end()]);
			}
		});

		test("does not let an obsolete metadata snapshot overwrite or cancel a newer content run", async () => {
			const setup = postgres(databaseUrl as string, { max: 1 });
			const snapshotClient = createDatabaseClient(databaseUrl as string, {
				max: 1,
			});
			const ownerId = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const newerGenerationId = crypto.randomUUID();
			const context: TenantContext = {
				userId: ownerId,
				role: "user",
				source: "personal",
			};

			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES (${ownerId}::uuid, ${`${ownerId}@metadata-superseded.invalid`})`;
				await setup`INSERT INTO public.documents (id, owner_id, title, content)
					VALUES (${documentId}::uuid, ${ownerId}::uuid, 'same', 'before')`;
				const snapshot = await withTenantDatabase(
					snapshotClient.db,
					context,
					(tx) => snapshotDocumentMetadataImpact(tx, context, documentId),
				);
				const [outbox] = await setup<{ id: string }[]>`
					SELECT id::text FROM public.metadata_reembed_outbox
					WHERE operation_id = ${snapshot.operationId}::uuid`;
				if (!outbox) throw new Error("superseded metadata outbox row missing");
				const newerRevision = contentHash("new title", "after");
				await setup`UPDATE public.documents
					SET title = 'new title',
						content = 'after',
						content_hash = ${newerRevision},
						embedding_status = 'processing',
						pending_embedding_generation = ${newerGenerationId}::uuid,
						updated_at = '2024-06-03T12:34:56.123456Z'::timestamp
					WHERE id = ${documentId}::uuid`;
				await setup`INSERT INTO public.document_pipeline_runs
					(document_id, owner_id, generation_id, revision, source, refresh_mode)
					VALUES (
						${documentId}::uuid,
						${ownerId}::uuid,
						${newerGenerationId}::uuid,
						${newerRevision},
						'interactive',
						'incremental'
					)`;
				const [before] = await setup<{ document: Record<string, unknown> }[]>`
					SELECT to_jsonb(document) AS document
					FROM public.documents AS document
					WHERE id = ${documentId}::uuid`;

				const result = await drainMetadataReembedOutbox(
					snapshot.operationId,
					10,
				);
				expect(result).toEqual({ enqueued: 0, completed: 1, failed: 0 });
				const [after] = await setup<{ document: Record<string, unknown> }[]>`
					SELECT to_jsonb(document) AS document
					FROM public.documents AS document
					WHERE id = ${documentId}::uuid`;
				expect(after?.document).toEqual(before?.document);
				const runs = await setup<{ generation_id: string; status: string }[]>`
					SELECT generation_id::text, status
					FROM public.document_pipeline_runs
					WHERE document_id = ${documentId}::uuid`;
				expect(
					runs.map(({ generation_id, status }) => ({ generation_id, status })),
				).toEqual([{ generation_id: newerGenerationId, status: "pending" }]);
				const [remaining] = await setup<{ count: number }[]>`
					SELECT count(*)::int AS count FROM public.metadata_reembed_outbox
					WHERE id = ${outbox.id}::uuid`;
				expect(remaining?.count).toBe(0);
			} finally {
				await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
				await Promise.all([setup.end(), snapshotClient.client.end()]);
			}
		});

		test("finds direct and two-level effective-category documents in owner and workspace tenants", async () => {
			const setup = postgres(databaseUrl as string, { max: 1 });
			const observations: DatabaseQueryObservation[] = [];
			const observed = createDatabaseClient(databaseUrl as string, {
				max: 1,
				queryObserver: (observation) => observations.push(observation),
			});
			const ownerId = crypto.randomUUID();
			const otherOwnerId = crypto.randomUUID();
			const personalCategoryId = crypto.randomUUID();
			const workspaceCategoryId = crypto.randomUUID();
			const personalFolders = [
				crypto.randomUUID(),
				crypto.randomUUID(),
				crypto.randomUUID(),
			] as const;
			const workspaceFolders = [
				crypto.randomUUID(),
				crypto.randomUUID(),
				crypto.randomUUID(),
			] as const;
			const personalDirect = crypto.randomUUID();
			const personalNested = crypto.randomUUID();
			const workspaceDirect = crypto.randomUUID();
			const workspaceNested = crypto.randomUUID();
			const foreignDocument = crypto.randomUUID();
			const workspaceId = `metadata-impact-${crypto.randomUUID()}`;
			const foreignWorkspaceId = `metadata-impact-foreign-${crypto.randomUUID()}`;

			try {
				await setup`INSERT INTO public.users (id, email)
				VALUES
					(${ownerId}::uuid, ${`${ownerId}@metadata-impact.invalid`}),
					(${otherOwnerId}::uuid, ${`${otherOwnerId}@metadata-impact.invalid`})`;
				await setup`INSERT INTO public.categories
				(id, owner_id, workspace_id, name)
				VALUES
					(${personalCategoryId}::uuid, ${ownerId}::uuid, NULL, 'personal impact'),
					(${workspaceCategoryId}::uuid, ${ownerId}::uuid, ${workspaceId}, 'workspace impact')`;
				await setup`INSERT INTO public.folders
				(id, owner_id, workspace_id, parent_id, category_id, name)
				VALUES
					(${personalFolders[0]}::uuid, ${ownerId}::uuid, NULL, NULL, ${personalCategoryId}::uuid, 'personal root'),
					(${personalFolders[1]}::uuid, ${ownerId}::uuid, NULL, ${personalFolders[0]}::uuid, NULL, 'personal child'),
					(${personalFolders[2]}::uuid, ${ownerId}::uuid, NULL, ${personalFolders[1]}::uuid, NULL, 'personal grandchild'),
					(${workspaceFolders[0]}::uuid, ${ownerId}::uuid, ${workspaceId}, NULL, ${workspaceCategoryId}::uuid, 'workspace root'),
					(${workspaceFolders[1]}::uuid, ${ownerId}::uuid, ${workspaceId}, ${workspaceFolders[0]}::uuid, NULL, 'workspace child'),
					(${workspaceFolders[2]}::uuid, ${ownerId}::uuid, ${workspaceId}, ${workspaceFolders[1]}::uuid, NULL, 'workspace grandchild')`;
				await setup`INSERT INTO public.documents
				(id, owner_id, workspace_id, folder_id, category_id, title, content)
				VALUES
					(${personalDirect}::uuid, ${ownerId}::uuid, NULL, NULL, ${personalCategoryId}::uuid, 'personal direct', ''),
					(${personalNested}::uuid, ${ownerId}::uuid, NULL, ${personalFolders[2]}::uuid, NULL, 'personal nested', ''),
					(${workspaceDirect}::uuid, ${ownerId}::uuid, ${workspaceId}, NULL, ${workspaceCategoryId}::uuid, 'workspace direct', ''),
					(${workspaceNested}::uuid, ${ownerId}::uuid, ${workspaceId}, ${workspaceFolders[2]}::uuid, NULL, 'workspace nested', ''),
					(${foreignDocument}::uuid, ${otherOwnerId}::uuid, ${foreignWorkspaceId}, NULL, NULL, 'foreign', '')`;

				const personal = await withTenantDatabase(
					observed.db,
					{ userId: ownerId, role: "user" },
					(tx) =>
						snapshotMetadataImpact(
							tx,
							{ userId: ownerId, role: "user" },
							{
								kind: "category",
								id: personalCategoryId,
							},
						),
				);
				const workspaceContext: TenantContext = {
					userId: ownerId,
					role: "user",
					workspaceId,
					source: "external",
				};
				const workspace = await withTenantDatabase(
					observed.db,
					workspaceContext,
					(tx) =>
						snapshotMetadataImpact(
							tx,
							workspaceContext,
							{ kind: "category", id: workspaceCategoryId },
							{ lockFolders: true },
						),
				);
				const folder = await withTenantDatabase(
					observed.db,
					workspaceContext,
					(tx) =>
						snapshotMetadataImpact(tx, workspaceContext, {
							kind: "folder",
							id: workspaceFolders[0],
						}),
				);
				const [personalOutbox, workspaceOutbox, folderOutbox] =
					await Promise.all([
						setup<{ document_id: string }[]>`
							SELECT document_id::text FROM public.metadata_reembed_outbox
							WHERE operation_id = ${personal.operationId}::uuid`,
						setup<{ document_id: string }[]>`
							SELECT document_id::text FROM public.metadata_reembed_outbox
							WHERE operation_id = ${workspace.operationId}::uuid`,
						setup<{ document_id: string }[]>`
							SELECT document_id::text FROM public.metadata_reembed_outbox
							WHERE operation_id = ${folder.operationId}::uuid`,
					]);

				expect(personal.folderIds).toEqual([...personalFolders].sort());
				expect(
					personalOutbox.map(({ document_id }) => document_id).sort(),
				).toEqual([personalDirect, personalNested].sort());
				expect(workspace.folderIds).toEqual([...workspaceFolders].sort());
				expect(
					workspaceOutbox.map(({ document_id }) => document_id).sort(),
				).toEqual([workspaceDirect, workspaceNested].sort());
				expect(
					folderOutbox.map(({ document_id }) => document_id).sort(),
				).toEqual([workspaceNested].sort());
				expect(
					workspaceOutbox.map(({ document_id }) => document_id),
				).not.toContain(foreignDocument);

				const normalized = observations.map(({ query }) =>
					query.replaceAll(/\s+/g, " ").trim().toLowerCase(),
				);
				const recursiveCategory = normalized.find((query) =>
					query.includes("docsmint:metadata-impact:category"),
				);
				const lock = normalized.find(
					(query) => query.includes("for update") && query.includes("order by"),
				);
				expect(recursiveCategory).toContain("with recursive resolved_folders");
				expect(recursiveCategory).toContain("effective_category_id");
				expect(lock).toContain('order by "folders"."id" asc for update');
			} finally {
				await setup`DELETE FROM public.users
				WHERE id IN (${ownerId}::uuid, ${otherOwnerId}::uuid)`;
				await observed.client.end();
				await setup.end();
			}
		});

		test("holds deterministic descendant locks through the document snapshot", async () => {
			const setup = postgres(databaseUrl as string, { max: 1 });
			const locker = createDatabaseClient(databaseUrl as string, { max: 1 });
			const attach = postgres(databaseUrl as string, { max: 1 });
			const observer = postgres(databaseUrl as string, { max: 1 });
			const ownerId = crypto.randomUUID();
			const rootId = crypto.randomUUID();
			const childId = crypto.randomUUID();
			const grandchildId = crypto.randomUUID();
			const detachedDocumentId = crypto.randomUUID();
			const snapshotReady = deferred<{
				blockerPid: number;
				targetCount: number;
			}>();
			const releaseLocks = deferred<void>();
			const attachPid = deferred<number>();

			try {
				await setup`INSERT INTO public.users (id, email)
				VALUES (${ownerId}::uuid, ${`${ownerId}@metadata-lock.invalid`})`;
				await setup`INSERT INTO public.folders (id, owner_id, parent_id, name)
				VALUES
					(${rootId}::uuid, ${ownerId}::uuid, NULL, 'root'),
					(${childId}::uuid, ${ownerId}::uuid, ${rootId}::uuid, 'child'),
					(${grandchildId}::uuid, ${ownerId}::uuid, ${childId}::uuid, 'grandchild')`;
				await setup`INSERT INTO public.documents (id, owner_id, title, content)
				VALUES (${detachedDocumentId}::uuid, ${ownerId}::uuid, 'detached', '')`;

				const context: TenantContext = { userId: ownerId, role: "user" };
				const lockTask = withTenantDatabase(locker.db, context, async (tx) => {
					const backendRows = (await tx.execute(
						sql`SELECT pg_backend_pid() AS pid`,
					)) as unknown as Array<{ pid: number }>;
					const snapshot = await snapshotMetadataImpact(
						tx,
						context,
						{ kind: "folder", id: rootId },
						{ lockFolders: true },
					);
					snapshotReady.resolve({
						blockerPid: backendRows[0]?.pid ?? -1,
						targetCount: snapshot.targetCount,
					});
					await releaseLocks.promise;
				});
				const attachTask = attach.begin(async (tx) => {
					const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
					attachPid.resolve(backend?.pid as number);
					await snapshotReady.promise;
					await tx`UPDATE public.documents SET folder_id = ${grandchildId}::uuid
					WHERE id = ${detachedDocumentId}::uuid`;
				});
				const snapshot = await snapshotReady.promise;
				let blockError: unknown;
				try {
					await waitForBlock(
						observer,
						await attachPid.promise,
						snapshot.blockerPid,
					);
				} catch (error) {
					blockError = error;
				} finally {
					releaseLocks.resolve();
				}
				expect(snapshot.targetCount).toBe(0);
				await Promise.all([lockTask, attachTask]);
				if (blockError) throw blockError;
			} finally {
				await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
				await Promise.all([
					setup.end(),
					locker.client.end(),
					attach.end(),
					observer.end(),
				]);
			}
		});

		test.each([
			"personal",
			"workspace",
		] as const)("serializes %s multi-level reparent and document attach behind a recursive delete snapshot", async (mode) => {
			const setup = postgres(databaseUrl as string, { max: 1 });
			const rowBlocker = postgres(databaseUrl as string, { max: 1 });
			const snapshotClient = createDatabaseClient(databaseUrl as string, {
				max: 1,
			});
			const mutationClient = createDatabaseClient(databaseUrl as string, {
				max: 1,
			});
			const observer = postgres(databaseUrl as string, { max: 1 });
			const ownerId = crypto.randomUUID();
			const workspaceId =
				mode === "workspace" ? `metadata-race-${crypto.randomUUID()}` : null;
			const rootId = "ffffffff-ffff-4fff-8fff-fffffffff201";
			const childId = "00000000-0000-4000-8000-000000000201";
			const grandchildId = "11111111-1111-4111-8111-111111111201";
			const detachedRootId = "22222222-2222-4222-8222-222222222201";
			const detachedChildId = "33333333-3333-4333-8333-333333333201";
			const detachedDocumentId = crypto.randomUUID();
			const attachDocumentId = crypto.randomUUID();
			const blockerReady = deferred<number>();
			const releaseBlocker = deferred<void>();
			const snapshotPid = deferred<number>();
			const mutationPid = deferred<number>();
			const context: TenantContext = workspaceId
				? {
						userId: ownerId,
						role: "user",
						source: "external",
						workspaceId,
					}
				: { userId: ownerId, role: "user", source: "personal" };

			try {
				await setup`INSERT INTO public.users (id, email)
						VALUES (${ownerId}::uuid, ${`${ownerId}@metadata-race.invalid`})`;
				await setup`INSERT INTO public.folders
						(id, owner_id, workspace_id, parent_id, name)
						VALUES
							(${rootId}::uuid, ${ownerId}::uuid, ${workspaceId}, NULL, 'root'),
							(${childId}::uuid, ${ownerId}::uuid, ${workspaceId}, ${rootId}::uuid, 'child'),
							(${grandchildId}::uuid, ${ownerId}::uuid, ${workspaceId}, ${childId}::uuid, 'grandchild'),
							(${detachedRootId}::uuid, ${ownerId}::uuid, ${workspaceId}, NULL, 'detached root'),
							(${detachedChildId}::uuid, ${ownerId}::uuid, ${workspaceId}, ${detachedRootId}::uuid, 'detached child')`;
				await setup`INSERT INTO public.documents
						(id, owner_id, workspace_id, folder_id, title, content)
						VALUES
							(${detachedDocumentId}::uuid, ${ownerId}::uuid, ${workspaceId}, ${detachedChildId}::uuid, 'reparented', ''),
							(${attachDocumentId}::uuid, ${ownerId}::uuid, ${workspaceId}, NULL, 'attached', '')`;

				const blockerTask = rowBlocker.begin(async (tx) => {
					const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
					await tx`SELECT id FROM public.folders
							WHERE id = ${childId}::uuid FOR UPDATE`;
					blockerReady.resolve(backend?.pid as number);
					await releaseBlocker.promise;
				});
				const blockerPid = await blockerReady.promise;
				const snapshotTask = withTenantDatabase(
					snapshotClient.db,
					context,
					async (tx) => {
						const backendRows = (await tx.execute(
							sql`SELECT pg_backend_pid() AS pid`,
						)) as unknown as Array<{ pid: number }>;
						snapshotPid.resolve(backendRows[0]?.pid ?? -1);
						return snapshotMetadataImpact(
							tx,
							context,
							{ kind: "folder", id: rootId },
							{ lockFolders: true },
						);
					},
				);
				await waitForBlock(observer, await snapshotPid.promise, blockerPid);

				const mutationTask = withTenantDatabase(
					mutationClient.db,
					context,
					async (tx) => {
						const backendRows = (await tx.execute(
							sql`SELECT pg_backend_pid() AS pid`,
						)) as unknown as Array<{ pid: number }>;
						mutationPid.resolve(backendRows[0]?.pid ?? -1);
						await acquireTenantTopologyLock(tx, context);
						await tx.execute(sql`UPDATE public.folders
								SET parent_id = ${grandchildId}::uuid
								WHERE id = ${detachedRootId}::uuid`);
						await tx.execute(sql`UPDATE public.documents
								SET folder_id = ${grandchildId}::uuid
								WHERE id = ${attachDocumentId}::uuid`);
					},
				);
				await waitForBlock(
					observer,
					await mutationPid.promise,
					await snapshotPid.promise,
				);
				releaseBlocker.resolve();
				const snapshot = await snapshotTask;
				await Promise.all([blockerTask, mutationTask]);

				expect(snapshot.targetCount).toBe(0);
				const [reparented] = await setup<{ parent_id: string }[]>`
						SELECT parent_id::text FROM public.folders
						WHERE id = ${detachedRootId}::uuid`;
				const [attached] = await setup<{ folder_id: string }[]>`
						SELECT folder_id::text FROM public.documents
						WHERE id = ${attachDocumentId}::uuid`;
				expect(reparented?.parent_id).toBe(grandchildId);
				expect(attached?.folder_id).toBe(grandchildId);
			} finally {
				releaseBlocker.resolve();
				await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
				await Promise.all([
					setup.end(),
					rowBlocker.end(),
					snapshotClient.client.end(),
					mutationClient.client.end(),
					observer.end(),
				]);
			}
		});
	},
);
