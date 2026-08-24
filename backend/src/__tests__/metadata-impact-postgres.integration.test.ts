import { describe, expect, test } from "bun:test";
import {
	createDatabaseClient,
	type DatabaseQueryObservation,
} from "@hiai-docs/db/client";
import {
	type TenantContext,
	withTenantDatabase,
} from "@hiai-docs/db/with-tenant";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { config } from "../lib/config";
import { contentHash } from "../lib/content-hash";
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
