import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { attachmentStorageCleanupOutbox } from "@hiai-docs/db/schema";
import {
	adminTenantContext,
	type TenantTransaction,
	withTenant,
	ZERO_UUID,
} from "@hiai-docs/db/with-tenant";
import { and, eq, inArray, sql } from "drizzle-orm";
import { logger } from "./logger";
import {
	getDocsMintRuntimeOptions,
	isRetryableQuotaError,
	type RuntimeAttachmentQuotaAdmission,
} from "./runtime-options";
import { BUCKET, storage } from "./storage";

const CLEANUP_ADMIN_TENANT = adminTenantContext(ZERO_UUID);
const DEFAULT_PAGE_SIZE = 100;
const LEASE_MS = 60_000;
const LEASE_SECONDS = LEASE_MS / 1_000;
/** Cleanup rows staged before PUT/copy stay unclaimable until the write ends. */
export const STORAGE_WRITE_HOLD_MS = 5 * 60_000;

export function storageWriteHoldNotBefore(now = new Date()): Date {
	return new Date(now.getTime() + STORAGE_WRITE_HOLD_MS);
}

/** Naive UTC timestamp so session TimeZone cannot shift lease/expiry bounds. */
export function utcTimestampSql(epochSeconds: number) {
	return sql`(to_timestamp(${epochSeconds}) AT TIME ZONE 'UTC')`;
}

function unixSeconds(now: Date): number {
	return now.getTime() / 1_000;
}

export type AttachmentCleanupSourceKind =
	| "attachment"
	| "pending_upload"
	| "uncommitted_upload";
export type AttachmentQuotaReleaseKind =
	| "none"
	| "reserve_pending"
	| "reservation"
	| "finalize_pending"
	| "committed";

export type AttachmentStorageCleanupIntent = Readonly<{
	sourceKind: AttachmentCleanupSourceKind;
	sourceId: string;
	storageKey: string;
	documentId: string;
	actorUserId: string;
	ownerUserId: string;
	requestedByUserId: string;
	workspaceId?: string | null;
	size: number;
	quotaOperationKey: string;
	quotaReleaseKind: AttachmentQuotaReleaseKind;
	quotaReservationId?: string | null;
	notBefore?: Date;
	retainUntil?: Date | null;
}>;

/** Insert the exact cleanup authority in the caller's mutation transaction. */
export async function stageAttachmentStorageCleanup(
	tx: TenantTransaction,
	intent: AttachmentStorageCleanupIntent,
): Promise<void> {
	await tx
		.insert(attachmentStorageCleanupOutbox)
		.values({
			sourceKind: intent.sourceKind,
			sourceId: intent.sourceId,
			storageKey: intent.storageKey,
			documentId: intent.documentId,
			actorUserId: intent.actorUserId,
			ownerUserId: intent.ownerUserId,
			requestedByUserId: intent.requestedByUserId,
			workspaceId: intent.workspaceId ?? null,
			size: intent.size,
			quotaOperationKey: intent.quotaOperationKey,
			quotaReleaseKind: intent.quotaReleaseKind,
			quotaReservationId: intent.quotaReservationId ?? null,
			notBefore: utcTimestampSql(unixSeconds(intent.notBefore ?? new Date())),
			retainUntil: intent.retainUntil
				? utcTimestampSql(unixSeconds(intent.retainUntil))
				: null,
		})
		.onConflictDoNothing({
			target: [
				attachmentStorageCleanupOutbox.sourceKind,
				attachmentStorageCleanupOutbox.sourceId,
			],
		});
}

/** Make a staged intent claimable after its storage write finished. */
export async function activateAttachmentStorageCleanup(
	tx: TenantTransaction,
	sourceKind: AttachmentCleanupSourceKind,
	sourceId: string,
	now = new Date(),
): Promise<void> {
	await tx.execute(sql`
		UPDATE public.attachment_storage_cleanup_outbox
		SET not_before = ${utcTimestampSql(unixSeconds(now))}
		WHERE source_kind = ${sourceKind}
			AND source_id = ${sourceId}::uuid
	`);
}

type ClaimedCleanupRow = Readonly<{
	id: string;
	storage_key: string;
	document_id: string;
	actor_user_id: string;
	owner_user_id: string;
	requested_by_user_id: string;
	workspace_id: string | null;
	size: number;
	quota_operation_key: string;
	quota_release_kind: AttachmentQuotaReleaseKind;
	quota_reservation_id: string | null;
	retain_until: Date | null;
}>;

type ClaimedCleanupRawRow = Omit<ClaimedCleanupRow, "retain_until"> &
	Readonly<{ retain_until_epoch: number | string | null }>;

function claimedCleanupRow(row: ClaimedCleanupRawRow): ClaimedCleanupRow {
	const retainUntilSeconds =
		row.retain_until_epoch === null ? null : Number(row.retain_until_epoch);
	if (retainUntilSeconds !== null && !Number.isFinite(retainUntilSeconds)) {
		throw new Error("attachment_cleanup_retain_until_invalid");
	}
	return {
		...row,
		retain_until:
			retainUntilSeconds === null ? null : new Date(retainUntilSeconds * 1_000),
	};
}

export type AttachmentStorageCleanupDrainResult = Readonly<{
	claimed: number;
	deleted: number;
	deferred: number;
	failed: number;
}>;

type CleanupDependencies = Readonly<{
	deleteObjects?: (
		keys: readonly string[],
		signal?: AbortSignal,
	) => Promise<number>;
	quotaAdmission?: RuntimeAttachmentQuotaAdmission | null;
	now?: () => Date;
	leaseOwner?: string;
	signal?: AbortSignal;
	pageSize?: number;
	maxPages?: number;
	actorUserId?: string;
	sourceKind?: AttachmentCleanupSourceKind;
	sourceId?: string;
}>;

async function deleteStorageObjects(keys: readonly string[]): Promise<number> {
	await Promise.all(
		keys.map((key) =>
			storage.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })),
		),
	);
	return keys.length;
}

async function claimCleanupPage(
	leaseOwner: string,
	now: Date,
	pageSize: number,
	quotaReleaseAvailable: boolean,
	filters: Readonly<{
		actorUserId?: string;
		sourceKind?: AttachmentCleanupSourceKind;
		sourceId?: string;
	}> = {},
): Promise<readonly ClaimedCleanupRow[]> {
	const nowEpoch = unixSeconds(now);
	const nowTimestamp = utcTimestampSql(nowEpoch);
	const leaseExpiresAt = utcTimestampSql(nowEpoch + LEASE_SECONDS);
	const actorFilter = filters.actorUserId
		? sql`AND (
			candidate.actor_user_id = ${filters.actorUserId}::uuid
			OR candidate.owner_user_id = ${filters.actorUserId}::uuid
			OR candidate.requested_by_user_id = ${filters.actorUserId}::uuid
		)`
		: sql``;
	const exactFilter =
		filters.sourceKind && filters.sourceId
			? sql`AND candidate.source_kind = ${filters.sourceKind}
				AND candidate.source_id = ${filters.sourceId}::uuid`
			: sql``;
	const quotaCapabilityFilter = quotaReleaseAvailable
		? sql``
		: sql`AND candidate.quota_release_kind = 'none'`;
	const rows = await withTenant(
		CLEANUP_ADMIN_TENANT,
		async (tx) =>
			(await tx.execute(sql`
			WITH candidates AS (
				SELECT candidate.id
				FROM public.attachment_storage_cleanup_outbox AS candidate
				WHERE candidate.not_before <= ${nowTimestamp}
					AND (
						candidate.lease_expires_at IS NULL
						OR candidate.lease_expires_at <= ${nowTimestamp}
					)
					AND NOT EXISTS (
						SELECT 1
						FROM public.pending_attachment_uploads AS pending
						WHERE pending.storage_key = candidate.storage_key
							AND pending.lease_owner LIKE 'confirm:%'
							AND pending.lease_expires_at IS NOT NULL
							AND pending.lease_expires_at > ${nowTimestamp}
					)
					${actorFilter}
					${exactFilter}
					${quotaCapabilityFilter}
				ORDER BY candidate.not_before, candidate.created_at, candidate.id
				FOR UPDATE SKIP LOCKED
				LIMIT ${pageSize}
			)
			UPDATE public.attachment_storage_cleanup_outbox AS cleanup
			SET lease_owner = ${leaseOwner},
				lease_expires_at = ${leaseExpiresAt},
				attempt_count = cleanup.attempt_count + 1,
				last_error = NULL
			FROM candidates
			WHERE cleanup.id = candidates.id
			RETURNING
				cleanup.id::text,
				cleanup.storage_key,
				cleanup.document_id::text,
				cleanup.actor_user_id::text,
				cleanup.owner_user_id::text,
				cleanup.requested_by_user_id::text,
				cleanup.workspace_id,
				cleanup.size::float8 AS size,
				cleanup.quota_operation_key,
				cleanup.quota_release_kind,
				cleanup.quota_reservation_id,
				extract(epoch FROM cleanup.retain_until)::float8 AS retain_until_epoch
		`)) as unknown as ClaimedCleanupRawRow[],
	);
	return rows.map(claimedCleanupRow);
}

function quotaContext(row: ClaimedCleanupRow, signal?: AbortSignal) {
	if (!row.workspace_id) return null;
	return {
		workspaceId: row.workspace_id,
		actorUserId: row.actor_user_id,
		documentId: row.document_id,
		storageKey: row.storage_key,
		proposedSize: row.size,
		requestId: row.id,
		idempotencyKey: row.quota_operation_key,
		signal,
	};
}

async function retainUntilFinalPass(
	row: ClaimedCleanupRow,
	leaseOwner: string,
	now: Date,
): Promise<boolean> {
	if (!row.retain_until || row.retain_until <= now) return false;
	const retainEpoch = unixSeconds(row.retain_until);
	const nowEpoch = unixSeconds(now);
	await withTenant(CLEANUP_ADMIN_TENANT, (tx) =>
		tx.execute(sql`
			UPDATE public.attachment_storage_cleanup_outbox
			SET not_before = ${utcTimestampSql(retainEpoch)},
				object_deleted_at = ${utcTimestampSql(nowEpoch)},
				lease_owner = NULL,
				lease_expires_at = NULL
			WHERE id = ${row.id}::uuid
				AND lease_owner = ${leaseOwner}
		`),
	);
	return true;
}

async function releaseQuota(
	row: ClaimedCleanupRow,
	admission: RuntimeAttachmentQuotaAdmission | null | undefined,
	signal?: AbortSignal,
): Promise<void> {
	if (row.quota_release_kind === "none") return;
	const context = quotaContext(row, signal);
	if (!admission || !context)
		throw new Error("attachment_quota_cleanup_unavailable");
	if (row.quota_release_kind === "reserve_pending") {
		const reservation = await admission.reserve(context);
		await admission.releaseReservation(context, reservation.id);
		return;
	}
	if (row.quota_release_kind === "reservation") {
		if (!row.quota_reservation_id)
			throw new Error("attachment_quota_reservation_missing");
		await admission.releaseReservation(context, row.quota_reservation_id);
		return;
	}
	if (row.quota_release_kind === "finalize_pending") {
		if (!row.quota_reservation_id)
			throw new Error("attachment_quota_reservation_missing");
		await admission.finalize(context, {
			reservationId: row.quota_reservation_id,
			actualSize: row.size,
		});
	}
	await admission.releaseCommitted(context);
}

async function releaseFailedClaims(
	rows: readonly ClaimedCleanupRow[],
	leaseOwner: string,
	now: Date,
	error: unknown,
): Promise<void> {
	if (rows.length === 0) return;
	const retryEpoch = unixSeconds(now) + LEASE_SECONDS;
	const lastError =
		error instanceof Error ? error.message.slice(0, 255) : "cleanup_failed";
	await withTenant(CLEANUP_ADMIN_TENANT, (tx) =>
		tx.execute(sql`
			UPDATE public.attachment_storage_cleanup_outbox
			SET not_before = ${utcTimestampSql(retryEpoch)},
				lease_owner = NULL,
				lease_expires_at = NULL,
				last_error = ${lastError}
			WHERE id IN (${sql.join(
				rows.map(({ id }) => sql`${id}::uuid`),
				sql`, `,
			)})
				AND lease_owner = ${leaseOwner}
		`),
	);
}

/** Drain bounded committed cleanup pages; leases prevent multi-instance overlap. */
export async function drainAttachmentStorageCleanupOutbox(
	dependencies: CleanupDependencies = {},
): Promise<AttachmentStorageCleanupDrainResult> {
	const nowFactory = dependencies.now ?? (() => new Date());
	const leaseOwner = dependencies.leaseOwner ?? crypto.randomUUID();
	const pageSize = Math.max(
		1,
		Math.min(dependencies.pageSize ?? DEFAULT_PAGE_SIZE, 500),
	);
	const maxPages = Math.max(1, dependencies.maxPages ?? 1);
	const deleteObjects = dependencies.deleteObjects ?? deleteStorageObjects;
	const quotaAdmission =
		dependencies.quotaAdmission ??
		getDocsMintRuntimeOptions()?.attachmentStorageQuotaAdmission;
	let claimed = 0;
	let deleted = 0;
	let deferred = 0;
	let failed = 0;

	for (let page = 0; page < maxPages; page += 1) {
		const now = nowFactory();
		const rows = await claimCleanupPage(
			leaseOwner,
			now,
			pageSize,
			quotaAdmission !== null && quotaAdmission !== undefined,
			{
				actorUserId: dependencies.actorUserId,
				sourceKind: dependencies.sourceKind,
				sourceId: dependencies.sourceId,
			},
		);
		if (rows.length === 0) break;
		claimed += rows.length;
		try {
			const removed = await deleteObjects(
				rows.map(({ storage_key }) => storage_key),
				dependencies.signal,
			);
			if (removed < rows.length)
				throw new Error("attachment_object_cleanup_incomplete");
			const acknowledged: string[] = [];
			for (const row of rows) {
				if (await retainUntilFinalPass(row, leaseOwner, now)) {
					deferred += 1;
					continue;
				}
				try {
					await releaseQuota(row, quotaAdmission, dependencies.signal);
					acknowledged.push(row.id);
				} catch (error) {
					if (isRetryableQuotaError(error)) {
						failed += 1;
						await releaseFailedClaims([row], leaseOwner, now, error);
					} else {
						logger.warn(
							{ err: error, cleanupId: row.id },
							"Terminal quota cleanup rejection; retiring intent",
						);
						acknowledged.push(row.id);
					}
				}
			}
			if (acknowledged.length > 0) {
				await withTenant(CLEANUP_ADMIN_TENANT, (tx) =>
					tx
						.delete(attachmentStorageCleanupOutbox)
						.where(
							and(
								inArray(attachmentStorageCleanupOutbox.id, acknowledged),
								eq(attachmentStorageCleanupOutbox.leaseOwner, leaseOwner),
							),
						),
				);
				deleted += acknowledged.length;
			}
		} catch (error) {
			failed += rows.length;
			await releaseFailedClaims(rows, leaseOwner, now, error);
			logger.error(
				{ err: error, cleanupIds: rows.map(({ id }) => id) },
				"Attachment storage cleanup page failed; retaining durable intents",
			);
		}
		if (rows.length < pageSize) break;
	}
	return { claimed, deleted, deferred, failed };
}

/** Drain one exact staged intent after its storage write has finished. */
export function drainExactAttachmentStorageCleanup(
	sourceKind: AttachmentCleanupSourceKind,
	sourceId: string,
	dependencies: Omit<CleanupDependencies, "sourceKind" | "sourceId"> = {},
): Promise<AttachmentStorageCleanupDrainResult> {
	return drainAttachmentStorageCleanupOutbox({
		...dependencies,
		sourceKind,
		sourceId,
		pageSize: 1,
		maxPages: 1,
	});
}

/** Best-effort post-commit dispatch; retained rows are recovered later. */
export function dispatchAttachmentStorageCleanup(): void {
	void drainAttachmentStorageCleanupOutbox().catch((error) => {
		logger.error(
			{ err: error },
			"Attachment storage cleanup dispatch deferred",
		);
	});
}
