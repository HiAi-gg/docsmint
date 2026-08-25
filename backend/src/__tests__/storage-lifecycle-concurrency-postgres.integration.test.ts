import { describe, expect, test } from "bun:test";
import { createDatabaseClient } from "@hiai-docs/db/client";
import { documentPipelineLockKey } from "@hiai-docs/db/document-pipeline-serialization";
import { withTenantDatabase } from "@hiai-docs/db/with-tenant";
import postgres from "postgres";
import {
	drainAttachmentStorageCleanupOutbox,
	drainExactAttachmentStorageCleanup,
	STORAGE_WRITE_HOLD_MS,
} from "../lib/attachment-storage-cleanup";
import { createPersistentLifecycleService } from "../lib/lifecycle-service";
import { AttachmentQuotaError } from "../lib/runtime-options";

const ownerDatabaseUrl = Bun.env.CONTENT_ACCESS_TEST_DATABASE_URL?.trim();
const runtimeDatabaseUrl = Bun.env.DATABASE_URL?.trim();

async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} deadlocked after ${ms}ms`)),
					ms,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe.skipIf(!ownerDatabaseUrl || !runtimeDatabaseUrl)(
	"storage and lifecycle PostgreSQL concurrency",
	() => {
		test("PUT write-hold keeps cleanup unclaimable until storage write activation", async () => {
			const setup = postgres(ownerDatabaseUrl as string, { max: 2 });
			const ownerId = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const sourceId = crypto.randomUUID();
			const storageKey = `write-hold/${documentId}/object.bin`;
			const deletedKeys: string[] = [];
			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES (${ownerId}::uuid, ${`${ownerId}@write-hold.invalid`})`;
				await setup`INSERT INTO public.documents (id, owner_id, title, content)
					VALUES (${documentId}::uuid, ${ownerId}::uuid, 'write hold', '')`;
				const holdUntil = new Date(Date.now() + STORAGE_WRITE_HOLD_MS);
				await setup`INSERT INTO public.attachment_storage_cleanup_outbox
					(source_kind, source_id, storage_key, document_id,
					 actor_user_id, owner_user_id, requested_by_user_id,
					 size, quota_operation_key, quota_release_kind, not_before)
					VALUES (
						'uncommitted_upload', ${sourceId}::uuid, ${storageKey},
						${documentId}::uuid, ${ownerId}::uuid, ${ownerId}::uuid,
						${ownerId}::uuid, 4, ${`hold-${sourceId}`}, 'none',
						to_timestamp(${holdUntil.getTime() / 1_000}) AT TIME ZONE 'UTC'
					)`;
				const duringWrite = await withTimeout(
					drainAttachmentStorageCleanupOutbox({
						leaseOwner: `hold-${crypto.randomUUID()}`,
						sourceKind: "uncommitted_upload",
						sourceId,
						deleteObjects: async (keys) => {
							deletedKeys.push(...keys);
							return keys.length;
						},
					}),
					8_000,
					"write-hold drain",
				);
				expect(duringWrite).toEqual({
					claimed: 0,
					deleted: 0,
					deferred: 0,
					failed: 0,
				});
				await setup`UPDATE public.attachment_storage_cleanup_outbox
					SET not_before = to_timestamp(${Date.now() / 1_000}) AT TIME ZONE 'UTC'
					WHERE source_id = ${sourceId}::uuid`;
				const afterWrite = await withTimeout(
					drainExactAttachmentStorageCleanup("uncommitted_upload", sourceId, {
						deleteObjects: async (keys) => {
							deletedKeys.push(...keys);
							return keys.length;
						},
					}),
					8_000,
					"activated drain",
				);
				expect(afterWrite).toEqual({
					claimed: 1,
					deleted: 1,
					deferred: 0,
					failed: 0,
				});
				expect(deletedKeys).toEqual([storageKey]);
			} finally {
				await setup`DELETE FROM public.attachment_storage_cleanup_outbox
					WHERE source_id = ${sourceId}::uuid`;
				await setup`DELETE FROM public.documents WHERE id = ${documentId}::uuid`;
				await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
				await setup.end();
			}
		}, 30_000);

		test("workspace duplicate quota exhaustion rejects before copied attachments exist", async () => {
			const setup = postgres(ownerDatabaseUrl as string, { max: 1 });
			const ownerId = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const copyId = crypto.randomUUID();
			const sourceId = crypto.randomUUID();
			const workspaceId = `workspace-${crypto.randomUUID()}`;
			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES (${ownerId}::uuid, ${`${ownerId}@quota-dup.invalid`})`;
				await setup`INSERT INTO public.documents
					(id, owner_id, workspace_id, title, content)
					VALUES (${documentId}::uuid, ${ownerId}::uuid, ${workspaceId},
						'source', '')`;
				await setup`INSERT INTO public.attachments
					(id, document_id, workspace_id, uploaded_by, filename, mime_type, size, storage_key)
					VALUES (${crypto.randomUUID()}::uuid, ${documentId}::uuid, ${workspaceId},
						${ownerId}::uuid, 'a.png', 'image/png', 8, ${`${workspaceId}/a.png`})`;
				await setup`INSERT INTO public.documents
					(id, owner_id, workspace_id, title, content)
					VALUES (${copyId}::uuid, ${ownerId}::uuid, ${workspaceId}, 'copy', '')`;
				await setup.unsafe("SET statement_timeout = '2s'");
				let rejected = false;
				try {
					await setup`INSERT INTO public.attachment_storage_cleanup_outbox
						(source_kind, source_id, storage_key, document_id,
						 actor_user_id, owner_user_id, requested_by_user_id, workspace_id,
						 size, quota_operation_key, quota_release_kind, quota_reservation_id)
						VALUES (
							'uncommitted_upload', ${sourceId}::uuid, ${`${workspaceId}/copy.png`},
							${copyId}::uuid, ${ownerId}::uuid, ${ownerId}::uuid, ${ownerId}::uuid,
							${workspaceId}, 8, ${`dup-${sourceId}`}, 'reservation', NULL
						)`;
				} catch (error) {
					rejected = true;
					expect(String(error)).toMatch(/23514|check|quota_release/i);
				}
				expect(rejected).toBe(true);
				await setup.unsafe("SET statement_timeout = '0'");
				await setup`INSERT INTO public.attachment_storage_cleanup_outbox
					(source_kind, source_id, storage_key, document_id,
					 actor_user_id, owner_user_id, requested_by_user_id, workspace_id,
					 size, quota_operation_key, quota_release_kind)
					VALUES (
						'uncommitted_upload', ${sourceId}::uuid, ${`${workspaceId}/copy.png`},
						${copyId}::uuid, ${ownerId}::uuid, ${ownerId}::uuid, ${ownerId}::uuid,
						${workspaceId}, 8, ${`dup-${sourceId}`}, 'reserve_pending'
					)`;
				const [copied] = await setup<{ count: number }[]>`
					SELECT count(*)::int AS count FROM public.attachments
					WHERE document_id = ${copyId}::uuid`;
				expect(copied?.count).toBe(0);
				const [kind] = await setup<{ quota_release_kind: string }[]>`
					SELECT quota_release_kind FROM public.attachment_storage_cleanup_outbox
					WHERE source_id = ${sourceId}::uuid`;
				expect(kind?.quota_release_kind).toBe("reserve_pending");
			} finally {
				await setup`DELETE FROM public.attachment_storage_cleanup_outbox
					WHERE source_id = ${sourceId}::uuid`;
				await setup`DELETE FROM public.attachments
					WHERE document_id IN (${documentId}::uuid, ${copyId}::uuid)`;
				await setup`DELETE FROM public.documents
					WHERE id IN (${documentId}::uuid, ${copyId}::uuid)`;
				await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
				await setup.end();
			}
		}, 30_000);

		test("confirm lease blocks expired-upload cleanup from deleting the object", async () => {
			const setup = postgres(ownerDatabaseUrl as string, { max: 2 });
			const ownerId = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const admissionId = crypto.randomUUID();
			const sourceId = crypto.randomUUID();
			const storageKey = `confirm-lease/${documentId}/live.png`;
			const deletedKeys: string[] = [];
			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES (${ownerId}::uuid, ${`${ownerId}@confirm-lease.invalid`})`;
				await setup`INSERT INTO public.documents (id, owner_id, title, content)
					VALUES (${documentId}::uuid, ${ownerId}::uuid, 'confirm lease', '')`;
				await setup`INSERT INTO public.pending_attachment_uploads
					(id, document_id, actor_user_id, storage_key, token_hash,
					 filename, mime_type, declared_size, quota_operation_key, quota_state,
					 lease_owner, lease_expires_at, expires_at)
					VALUES (
						${admissionId}::uuid, ${documentId}::uuid, ${ownerId}::uuid,
						${storageKey}, ${`hash-${admissionId}`}, 'live.png', 'image/png', 4,
						${`attachment:${documentId}:${storageKey}`}, 'not_required',
						${`confirm:${crypto.randomUUID()}`}, now() + interval '5 minutes',
						now() + interval '15 minutes'
					)`;
				await setup`INSERT INTO public.attachment_storage_cleanup_outbox
					(source_kind, source_id, storage_key, document_id,
					 actor_user_id, owner_user_id, requested_by_user_id,
					 size, quota_operation_key, quota_release_kind, not_before)
					VALUES (
						'pending_upload', ${sourceId}::uuid, ${storageKey},
						${documentId}::uuid, ${ownerId}::uuid, ${ownerId}::uuid,
						${ownerId}::uuid, 4, ${`confirm-${sourceId}`}, 'none', now()
					)`;
				const result = await withTimeout(
					drainAttachmentStorageCleanupOutbox({
						leaseOwner: `expired-${crypto.randomUUID()}`,
						deleteObjects: async (keys) => {
							deletedKeys.push(...keys);
							return keys.length;
						},
					}),
					8_000,
					"confirm-lease drain",
				);
				expect(result.claimed).toBe(0);
				expect(deletedKeys).toEqual([]);
				const [pending] = await setup<{ count: number }[]>`
					SELECT count(*)::int AS count FROM public.pending_attachment_uploads
					WHERE id = ${admissionId}::uuid`;
				expect(pending?.count).toBe(1);
			} finally {
				await setup`DELETE FROM public.attachment_storage_cleanup_outbox
					WHERE source_id = ${sourceId}::uuid`;
				await setup`DELETE FROM public.pending_attachment_uploads
					WHERE id = ${admissionId}::uuid`;
				await setup`DELETE FROM public.documents WHERE id = ${documentId}::uuid`;
				await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
				await setup.end();
			}
		}, 30_000);

		test("account purge pages attachments beyond the cleanup batch size", async () => {
			const setup = postgres(ownerDatabaseUrl as string, { max: 1 });
			const lifecycleClient = createDatabaseClient(
				runtimeDatabaseUrl as string,
			);
			const ownerId = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const total = 101;
			const deletedKeys: string[] = [];
			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES (${ownerId}::uuid, ${`${ownerId}@lifecycle-pages.invalid`})`;
				await setup`INSERT INTO public.documents (id, owner_id, title, content)
					VALUES (${documentId}::uuid, ${ownerId}::uuid, 'paged purge', '')`;
				for (let index = 0; index < total; index += 1) {
					const attachmentId = crypto.randomUUID();
					await setup`INSERT INTO public.attachments
						(id, document_id, uploaded_by, filename, mime_type, size, storage_key)
						VALUES (
							${attachmentId}::uuid, ${documentId}::uuid, ${ownerId}::uuid,
							${`file-${index}.png`}, 'image/png', 1,
							${`paged/${documentId}/${index}.png`}
						)`;
				}
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
				const result = await withTimeout(
					lifecycle.purgeUserData(
						{
							actorUserId: ownerId,
							requestId: crypto.randomUUID(),
							idempotencyKey: `pages-${crypto.randomUUID()}`,
							reason: "account_deletion",
						},
						{ fenceToken: "pages" },
					),
					20_000,
					"paged account purge",
				);
				expect(result.status).toBe("completed");
				expect(deletedKeys).toHaveLength(total);
				const [remaining] = await setup<
					Array<{ attachments: number; documents: number }>
				>`SELECT
					(SELECT count(*)::int FROM public.attachments WHERE document_id = ${documentId}::uuid) AS attachments,
					(SELECT count(*)::int FROM public.documents WHERE id = ${documentId}::uuid) AS documents`;
				expect(remaining).toEqual({ attachments: 0, documents: 0 });
			} finally {
				await setup`DELETE FROM public.attachment_storage_cleanup_outbox
					WHERE owner_user_id = ${ownerId}::uuid`;
				await setup`DELETE FROM public.attachments WHERE document_id = ${documentId}::uuid`;
				await setup`DELETE FROM public.documents WHERE id = ${documentId}::uuid`;
				await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
				await Promise.all([lifecycleClient.client.end(), setup.end()]);
			}
		}, 60_000);

		test("restore and hard purge serialize on the document pipeline lock without deadlock", async () => {
			const restore = postgres(ownerDatabaseUrl as string, { max: 1 });
			const purge = postgres(ownerDatabaseUrl as string, { max: 1 });
			const setup = postgres(ownerDatabaseUrl as string, { max: 1 });
			const ownerId = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const lockKey = documentPipelineLockKey(documentId).toString();
			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES (${ownerId}::uuid, ${`${ownerId}@restore-purge.invalid`})`;
				await setup`INSERT INTO public.documents
					(id, owner_id, title, content, deleted_at)
					VALUES (${documentId}::uuid, ${ownerId}::uuid, 'trashed', '', now())`;
				const outcomes = await withTimeout(
					Promise.all([
						restore.begin(async (tx) => {
							await tx`SELECT pg_advisory_xact_lock(${lockKey}::bigint)`;
							await tx`SELECT pg_sleep(0.2)`;
							return tx`UPDATE public.documents
								SET deleted_at = NULL
								WHERE id = ${documentId}::uuid AND deleted_at IS NOT NULL
								RETURNING id::text`;
						}),
						purge.begin(async (tx) => {
							await tx`SELECT pg_advisory_xact_lock(${lockKey}::bigint)`;
							return tx`DELETE FROM public.documents
								WHERE id = ${documentId}::uuid AND deleted_at IS NOT NULL
								RETURNING id::text`;
						}),
					]),
					8_000,
					"restore versus hard purge",
				);
				const changed = outcomes.flat().length;
				expect(changed).toBe(1);
				const [row] = await setup<
					Array<{ present: number; deleted: Date | null }>
				>`
					SELECT count(*)::int AS present, max(deleted_at) AS deleted
					FROM public.documents WHERE id = ${documentId}::uuid`;
				expect(row?.present === 0 || row?.deleted === null).toBe(true);
			} finally {
				await setup`DELETE FROM public.documents WHERE id = ${documentId}::uuid`;
				await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
				await Promise.all([restore.end(), purge.end(), setup.end()]);
			}
		}, 30_000);

		test("terminal quota rejection retires cleanup instead of retrying forever", async () => {
			const setup = postgres(ownerDatabaseUrl as string, { max: 1 });
			const ownerId = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const sourceId = crypto.randomUUID();
			const workspaceId = `workspace-${crypto.randomUUID()}`;
			const storageKey = `${workspaceId}/terminal.png`;
			let reserveCalls = 0;
			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES (${ownerId}::uuid, ${`${ownerId}@terminal-quota.invalid`})`;
				await setup`INSERT INTO public.documents
					(id, owner_id, workspace_id, title, content)
					VALUES (${documentId}::uuid, ${ownerId}::uuid, ${workspaceId},
						'terminal quota', '')`;
				await setup`INSERT INTO public.attachment_storage_cleanup_outbox
					(source_kind, source_id, storage_key, document_id,
					 actor_user_id, owner_user_id, requested_by_user_id, workspace_id,
					 size, quota_operation_key, quota_release_kind)
					VALUES (
						'uncommitted_upload', ${sourceId}::uuid, ${storageKey},
						${documentId}::uuid, ${ownerId}::uuid, ${ownerId}::uuid,
						${ownerId}::uuid, ${workspaceId}, 8, ${`terminal-${sourceId}`},
						'reserve_pending'
					)`;
				const first = await withTimeout(
					drainExactAttachmentStorageCleanup("uncommitted_upload", sourceId, {
						deleteObjects: async (keys) => keys.length,
						quotaAdmission: {
							async reserve() {
								reserveCalls += 1;
								throw new AttachmentQuotaError("quota exceeded", false);
							},
							async finalize() {},
							async releaseReservation() {},
							async releaseCommitted() {},
						},
					}),
					8_000,
					"terminal quota drain",
				);
				expect(first).toEqual({
					claimed: 1,
					deleted: 1,
					deferred: 0,
					failed: 0,
				});
				const second = await withTimeout(
					drainExactAttachmentStorageCleanup("uncommitted_upload", sourceId, {
						deleteObjects: async (keys) => keys.length,
						quotaAdmission: {
							async reserve() {
								reserveCalls += 1;
								throw new AttachmentQuotaError("quota exceeded", false);
							},
							async finalize() {},
							async releaseReservation() {},
							async releaseCommitted() {},
						},
					}),
					8_000,
					"retired terminal quota drain",
				);
				expect(second.claimed).toBe(0);
				expect(reserveCalls).toBe(1);
			} finally {
				await setup`DELETE FROM public.attachment_storage_cleanup_outbox
					WHERE source_id = ${sourceId}::uuid`;
				await setup`DELETE FROM public.documents WHERE id = ${documentId}::uuid`;
				await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
				await setup.end();
			}
		}, 30_000);

		test("rejected-confirm exact drain ignores a backlog larger than one page", async () => {
			const setup = postgres(ownerDatabaseUrl as string, { max: 1 });
			const ownerId = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const targetId = crypto.randomUUID();
			const backlogIds = Array.from({ length: 120 }, () => crypto.randomUUID());
			const deletedKeys: string[] = [];
			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES (${ownerId}::uuid, ${`${ownerId}@exact-backlog.invalid`})`;
				await setup`INSERT INTO public.documents (id, owner_id, title, content)
					VALUES (${documentId}::uuid, ${ownerId}::uuid, 'backlog', '')`;
				for (const [index, sourceId] of backlogIds.entries()) {
					await setup`INSERT INTO public.attachment_storage_cleanup_outbox
						(source_kind, source_id, storage_key, document_id,
						 actor_user_id, owner_user_id, requested_by_user_id,
						 size, quota_operation_key, quota_release_kind, not_before)
						VALUES (
							'pending_upload', ${sourceId}::uuid, ${`backlog/${index}`},
							${documentId}::uuid, ${ownerId}::uuid, ${ownerId}::uuid,
							${ownerId}::uuid, 1, ${`backlog-${sourceId}`}, 'none',
							to_timestamp(${Date.now() / 1_000 - 120 + index}) AT TIME ZONE 'UTC'
						)`;
				}
				await setup`INSERT INTO public.attachment_storage_cleanup_outbox
					(source_kind, source_id, storage_key, document_id,
					 actor_user_id, owner_user_id, requested_by_user_id,
					 size, quota_operation_key, quota_release_kind, not_before)
					VALUES (
						'pending_upload', ${targetId}::uuid, 'backlog/target',
						${documentId}::uuid, ${ownerId}::uuid, ${ownerId}::uuid,
						${ownerId}::uuid, 1, ${`target-${targetId}`}, 'none',
						to_timestamp(${Date.now() / 1_000 + 1}) AT TIME ZONE 'UTC'
					)`;
				const result = await withTimeout(
					drainExactAttachmentStorageCleanup("pending_upload", targetId, {
						now: () => new Date(Date.now() + 2_000),
						deleteObjects: async (keys) => {
							deletedKeys.push(...keys);
							return keys.length;
						},
					}),
					8_000,
					"exact backlog drain",
				);
				expect(result).toEqual({
					claimed: 1,
					deleted: 1,
					deferred: 0,
					failed: 0,
				});
				expect(deletedKeys).toEqual(["backlog/target"]);
				const [remaining] = await setup<{ count: number }[]>`
					SELECT count(*)::int AS count
					FROM public.attachment_storage_cleanup_outbox
					WHERE document_id = ${documentId}::uuid`;
				expect(remaining?.count).toBe(120);
			} finally {
				await setup`DELETE FROM public.attachment_storage_cleanup_outbox
					WHERE document_id = ${documentId}::uuid`;
				await setup`DELETE FROM public.documents WHERE id = ${documentId}::uuid`;
				await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
				await setup.end();
			}
		}, 60_000);

		test("account purge and attachment mutation serialize without deadlock", async () => {
			const setup = postgres(ownerDatabaseUrl as string, { max: 1 });
			const purge = postgres(ownerDatabaseUrl as string, { max: 1 });
			const mutate = postgres(runtimeDatabaseUrl as string, { max: 1 });
			const ownerId = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const attachmentId = crypto.randomUUID();
			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES (${ownerId}::uuid, ${`${ownerId}@purge-mutate.invalid`})`;
				await setup`INSERT INTO public.documents (id, owner_id, title, content)
					VALUES (${documentId}::uuid, ${ownerId}::uuid, 'live', '')`;
				await setup`INSERT INTO public.attachments
					(id, document_id, uploaded_by, filename, mime_type, size, storage_key)
					VALUES (
						${attachmentId}::uuid, ${documentId}::uuid, ${ownerId}::uuid,
						'live.png', 'image/png', 2, ${`mutate/${documentId}/live.png`}
					)`;
				const outcomes = await withTimeout(
					Promise.allSettled([
						purge.begin(async (tx) => {
							await tx`SELECT public.acquire_account_purge_fence_lock(${ownerId}::uuid)`;
							await tx`SELECT pg_sleep(0.2)`;
							await tx`DELETE FROM public.attachments WHERE id = ${attachmentId}::uuid`;
							await tx`DELETE FROM public.documents WHERE id = ${documentId}::uuid`;
						}),
						mutate.begin(async (tx) => {
							await tx`SELECT set_config('app.current_user_id', ${ownerId}, true)`;
							await tx`SELECT set_config('app.current_user_role', 'user', true)`;
							await tx`SELECT set_config('app.current_workspace_id', '', true)`;
							await tx`UPDATE public.attachments
								SET filename = 'renamed.png'
								WHERE id = ${attachmentId}::uuid`;
						}),
					]),
					8_000,
					"purge versus attachment mutation",
				);
				expect(
					outcomes.every(
						(outcome) =>
							outcome.status === "fulfilled" || outcome.status === "rejected",
					),
				).toBe(true);
				expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(
					true,
				);
			} finally {
				await setup`DELETE FROM public.attachments WHERE id = ${attachmentId}::uuid`;
				await setup`DELETE FROM public.documents WHERE id = ${documentId}::uuid`;
				await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
				await Promise.all([purge.end(), mutate.end(), setup.end()]);
			}
		}, 30_000);
	},
);
