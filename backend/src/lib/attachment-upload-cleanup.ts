import { pendingAttachmentUploads } from "@hiai-docs/db/schema";
import {
	adminTenantContext,
	type TenantContext,
	type TenantTransaction,
	withTenant,
	ZERO_UUID,
} from "@hiai-docs/db/with-tenant";
import { and, eq, sql } from "drizzle-orm";
import {
	drainAttachmentStorageCleanupOutbox,
	stageAttachmentStorageCleanup,
} from "./attachment-storage-cleanup";
import { logger } from "./logger";
import {
	getDocsMintRuntimeOptions,
	type RuntimeAttachmentQuotaAdmission,
} from "./runtime-options";

const CLEANUP_ADMIN_TENANT = adminTenantContext(ZERO_UUID);
const CLEANUP_PAGE_SIZE = 100;
const CLEANUP_INTERVAL_MS = 60_000;
const LEASE_MS = 60_000;

export type PendingAttachmentQuotaState =
	| "not_required"
	| "reserve_pending"
	| "reserved"
	| "finalize_pending"
	| "committed";

export type PendingAttachmentUploadRow = Readonly<{
	id: string;
	documentId: string;
	ownerUserId: string;
	actorUserId: string;
	workspaceId: string | null;
	storageKey: string;
	tokenHash: string;
	filename: string;
	mimeType: string;
	declaredSize: number;
	quotaReservationId: string | null;
	quotaOperationKey: string;
	quotaState: PendingAttachmentQuotaState;
	actualSize: number | null;
	urlIssuedAt: Date | null;
	expiresAt: Date;
	leaseOwner: string | null;
}>;

export type ClaimedPendingAttachmentUploadRow = PendingAttachmentUploadRow &
	Readonly<{ leaseOwner: string }>;

export type PendingAttachmentAbandonmentProof = Readonly<{
	id: string;
	documentId: string;
	storageKey: string;
	tokenHash: string;
	leaseOwner?: string | null;
}>;

type PendingRawRow = Readonly<{
	id: string;
	document_id: string;
	owner_user_id: string;
	actor_user_id: string;
	workspace_id: string | null;
	storage_key: string;
	token_hash: string;
	filename: string;
	mime_type: string;
	declared_size: number;
	quota_reservation_id: string | null;
	quota_operation_key: string;
	quota_state: PendingAttachmentQuotaState;
	actual_size: number | null;
	url_issued_at_epoch: number | string | null;
	expires_at_epoch: number | string;
	lease_owner: string | null;
}>;

function dateFromEpochSeconds(value: number | string, field: string): Date {
	const seconds = Number(value);
	if (!Number.isFinite(seconds)) throw new Error(`${field}_invalid`);
	return new Date(seconds * 1_000);
}

function pendingRow(row: PendingRawRow): PendingAttachmentUploadRow {
	return {
		id: row.id,
		documentId: row.document_id,
		ownerUserId: row.owner_user_id,
		actorUserId: row.actor_user_id,
		workspaceId: row.workspace_id,
		storageKey: row.storage_key,
		tokenHash: row.token_hash,
		filename: row.filename,
		mimeType: row.mime_type,
		declaredSize: Number(row.declared_size),
		quotaReservationId: row.quota_reservation_id,
		quotaOperationKey: row.quota_operation_key,
		quotaState: row.quota_state,
		actualSize: row.actual_size === null ? null : Number(row.actual_size),
		urlIssuedAt:
			row.url_issued_at_epoch === null
				? null
				: dateFromEpochSeconds(
						row.url_issued_at_epoch,
						"pending_attachment_url_issued_at",
					),
		expiresAt: dateFromEpochSeconds(
			row.expires_at_epoch,
			"pending_attachment_expires_at",
		),
		leaseOwner: row.lease_owner,
	};
}

function quotaContext(row: PendingAttachmentUploadRow, signal?: AbortSignal) {
	if (!row.workspaceId) return null;
	return {
		workspaceId: row.workspaceId,
		actorUserId: row.actorUserId,
		documentId: row.documentId,
		storageKey: row.storageKey,
		proposedSize: row.declaredSize,
		requestId: row.id,
		idempotencyKey: row.quotaOperationKey,
		signal,
	};
}

async function claimExpiredPendingUploads(
	leaseOwner: string,
	now: Date,
	limit: number,
): Promise<readonly PendingAttachmentUploadRow[]> {
	// Raw postgres-js SQL does not run Drizzle's timestamp column encoder.
	const nowTimestamp = now.toISOString();
	const leaseExpiresAt = new Date(now.getTime() + LEASE_MS).toISOString();
	const rows = await withTenant(
		CLEANUP_ADMIN_TENANT,
		async (tx) =>
			(await tx.execute(sql`
			WITH candidates AS (
				SELECT pending.id
				FROM public.pending_attachment_uploads AS pending
				WHERE (
					pending.expires_at <= ${nowTimestamp}
					OR (
						pending.url_issued_at IS NULL
						AND (
							pending.lease_expires_at IS NULL
							OR pending.lease_expires_at <= ${nowTimestamp}
						)
					)
				)
				AND (
					pending.lease_expires_at IS NULL
					OR pending.lease_expires_at <= ${nowTimestamp}
				)
				ORDER BY pending.expires_at, pending.id
				FOR UPDATE SKIP LOCKED
				LIMIT ${limit}
			)
			UPDATE public.pending_attachment_uploads AS pending
			SET lease_owner = ${leaseOwner},
				lease_expires_at = ${leaseExpiresAt},
				attempt_count = pending.attempt_count + 1,
				last_error = NULL
			FROM candidates, public.documents AS parent
			WHERE pending.id = candidates.id
				AND parent.id = pending.document_id
			RETURNING
				pending.id::text,
				pending.document_id::text,
				parent.owner_id::text AS owner_user_id,
				pending.actor_user_id::text,
				pending.workspace_id,
				pending.storage_key,
				pending.token_hash,
				pending.filename,
				pending.mime_type,
				pending.declared_size::float8 AS declared_size,
				pending.quota_reservation_id,
				pending.quota_operation_key,
				pending.quota_state,
				pending.actual_size::float8 AS actual_size,
				extract(epoch FROM pending.url_issued_at)::float8 AS url_issued_at_epoch,
				extract(epoch FROM pending.expires_at)::float8 AS expires_at_epoch,
				pending.lease_owner
		`)) as unknown as PendingRawRow[],
	);
	return rows.map(pendingRow);
}

async function recordPendingFailure(
	row: PendingAttachmentUploadRow,
	leaseOwner: string,
	error: unknown,
): Promise<void> {
	await withTenant(CLEANUP_ADMIN_TENANT, (tx) =>
		tx
			.update(pendingAttachmentUploads)
			.set({
				leaseOwner: null,
				leaseExpiresAt: new Date(Date.now() + LEASE_MS),
				lastError:
					error instanceof Error
						? error.message.slice(0, 255)
						: "cleanup_failed",
			})
			.where(
				and(
					eq(pendingAttachmentUploads.id, row.id),
					eq(pendingAttachmentUploads.leaseOwner, leaseOwner),
				),
			),
	);
}

async function advancePendingQuota(
	row: PendingAttachmentUploadRow,
	leaseOwner: string,
	admission: RuntimeAttachmentQuotaAdmission | undefined,
): Promise<PendingAttachmentUploadRow> {
	let current = row;
	const context = quotaContext(current);
	if (current.quotaState === "reserve_pending") {
		if (!admission || !context)
			throw new Error("attachment_quota_reserve_unavailable");
		const reservation = await admission.reserve(context);
		await withTenant(CLEANUP_ADMIN_TENANT, (tx) =>
			tx
				.update(pendingAttachmentUploads)
				.set({ quotaReservationId: reservation.id, quotaState: "reserved" })
				.where(
					and(
						eq(pendingAttachmentUploads.id, current.id),
						eq(pendingAttachmentUploads.leaseOwner, leaseOwner),
					),
				),
		);
		current = {
			...current,
			quotaReservationId: reservation.id,
			quotaState: "reserved",
		};
	}
	if (current.quotaState === "finalize_pending") {
		if (
			!admission ||
			!context ||
			!current.quotaReservationId ||
			current.actualSize === null
		)
			throw new Error("attachment_quota_finalize_unavailable");
		await admission.finalize(context, {
			reservationId: current.quotaReservationId,
			actualSize: current.actualSize,
		});
		await withTenant(CLEANUP_ADMIN_TENANT, (tx) =>
			tx
				.update(pendingAttachmentUploads)
				.set({ quotaState: "committed" })
				.where(
					and(
						eq(pendingAttachmentUploads.id, current.id),
						eq(pendingAttachmentUploads.leaseOwner, leaseOwner),
					),
				),
		);
		current = { ...current, quotaState: "committed" };
	}
	return current;
}

function quotaReleaseFor(row: PendingAttachmentUploadRow): {
	kind:
		| "none"
		| "reserve_pending"
		| "reservation"
		| "finalize_pending"
		| "committed";
	reservationId: string | null;
} {
	if (row.quotaState === "not_required")
		return { kind: "none", reservationId: null };
	if (row.quotaState === "reserve_pending")
		return { kind: "reserve_pending", reservationId: null };
	if (row.quotaState === "reserved") {
		if (!row.quotaReservationId)
			throw new Error("attachment_quota_reservation_missing");
		return { kind: "reservation", reservationId: row.quotaReservationId };
	}
	if (row.quotaState === "committed")
		return { kind: "committed", reservationId: null };
	if (row.quotaState === "finalize_pending") {
		if (!row.quotaReservationId)
			throw new Error("attachment_quota_reservation_missing");
		return { kind: "finalize_pending", reservationId: row.quotaReservationId };
	}
	throw new Error(`attachment_quota_state_unknown:${row.quotaState}`);
}

export async function stagePendingAttachmentCleanup(
	tx: TenantTransaction,
	row: PendingAttachmentUploadRow,
	requestedByUserId: string,
	now = new Date(),
): Promise<void> {
	const quota = quotaReleaseFor(row);
	await stageAttachmentStorageCleanup(tx, {
		sourceKind: "pending_upload",
		sourceId: row.id,
		storageKey: row.storageKey,
		documentId: row.documentId,
		actorUserId: row.actorUserId,
		ownerUserId: row.ownerUserId,
		requestedByUserId,
		workspaceId: row.workspaceId,
		size: row.actualSize ?? row.declaredSize,
		quotaOperationKey: row.quotaOperationKey,
		quotaReleaseKind: quota.kind,
		quotaReservationId: quota.reservationId,
		notBefore: now,
		retainUntil: row.urlIssuedAt ? row.expiresAt : null,
	});
	await tx
		.delete(pendingAttachmentUploads)
		.where(eq(pendingAttachmentUploads.id, row.id));
}

/** Atomically claim one live admission for confirm; cleanup uses the same lease. */
export async function claimPendingAttachmentUploadForConfirm(
	ctx: TenantContext,
	input: Readonly<{
		id: string;
		documentId: string;
		storageKey: string;
		tokenHash: string;
	}>,
): Promise<ClaimedPendingAttachmentUploadRow | null> {
	const now = new Date();
	const nowTimestamp = now.toISOString();
	const leaseOwner = `confirm:${crypto.randomUUID()}`;
	const leaseExpiresAt = new Date(now.getTime() + 5 * 60_000);
	const rows = await withTenant(ctx, async (tx) => {
		const locked = (await tx.execute(sql`
			SELECT
				pending.id::text,
				pending.document_id::text,
				parent.owner_id::text AS owner_user_id,
				pending.actor_user_id::text,
				pending.workspace_id,
				pending.storage_key,
				pending.token_hash,
				pending.filename,
				pending.mime_type,
				pending.declared_size::float8 AS declared_size,
				pending.quota_reservation_id,
				pending.quota_operation_key,
				pending.quota_state,
				pending.actual_size::float8 AS actual_size,
				extract(epoch FROM pending.url_issued_at)::float8 AS url_issued_at_epoch,
				extract(epoch FROM pending.expires_at)::float8 AS expires_at_epoch,
				pending.lease_owner
			FROM public.pending_attachment_uploads AS pending
			JOIN public.documents AS parent ON parent.id = pending.document_id
			WHERE pending.id = ${input.id}::uuid
				AND pending.document_id = ${input.documentId}::uuid
				AND pending.storage_key = ${input.storageKey}
				AND pending.token_hash = ${input.tokenHash}
				AND pending.expires_at > ${nowTimestamp}
				AND (
					pending.lease_expires_at IS NULL
					OR pending.lease_expires_at <= ${nowTimestamp}
				)
			FOR UPDATE OF pending
		`)) as unknown as PendingRawRow[];
		if (locked.length !== 1) return [];
		await tx
			.update(pendingAttachmentUploads)
			.set({
				confirmingAt: now,
				leaseOwner,
				leaseExpiresAt,
				attemptCount: sql`${pendingAttachmentUploads.attemptCount} + 1`,
			})
			.where(eq(pendingAttachmentUploads.id, input.id));
		return locked.map((row) => ({ ...row, lease_owner: leaseOwner }));
	});
	return rows[0]
		? (pendingRow(rows[0]) as ClaimedPendingAttachmentUploadRow)
		: null;
}

/**
 * Atomically abandon one exact signed admission through the DB-owned proof
 * procedure. This remains safe after the actor fence commits and races
 * idempotently with lifecycle/expiry cleanup.
 */
export async function abandonPendingAttachmentUploadByProof(
	ctx: TenantContext,
	proof: PendingAttachmentAbandonmentProof,
): Promise<boolean> {
	const rows = await withTenant(
		ctx,
		async (tx) =>
			(await tx.execute(sql`
				SELECT public.abandon_pending_attachment_upload(
					${proof.id}::uuid,
					${proof.documentId}::uuid,
					${proof.storageKey},
					${proof.tokenHash},
					${proof.leaseOwner ?? null}
				) AS abandoned
			`)) as unknown as Array<{ abandoned: boolean }>,
	);
	const abandoned = rows[0]?.abandoned === true;
	// Confirmation is synchronous: once the signed admission has been
	// authenticated, make the first exact-key delete attempt before responding.
	// The durable row remains authoritative if storage/quota cleanup fails and a
	// second retained pass still runs at URL expiry to catch a late PUT.
	if (abandoned) await drainAttachmentStorageCleanupOutbox({ maxPages: 1 });
	return abandoned;
}

/** Convert a claimed failed confirmation to an exact DB-first cleanup intent. */
export async function abandonClaimedPendingAttachmentUpload(
	ctx: TenantContext,
	row: PendingAttachmentUploadRow,
): Promise<void> {
	await abandonPendingAttachmentUploadByProof(ctx, {
		id: row.id,
		documentId: row.documentId,
		storageKey: row.storageKey,
		tokenHash: row.tokenHash,
		leaseOwner: row.leaseOwner,
	});
}

/** Recover one bounded page of expired/crashed admissions, then drain intents. */
export async function cleanupExpiredAttachmentUploads(): Promise<number> {
	const now = new Date();
	const leaseOwner = `pending-cleanup:${crypto.randomUUID()}`;
	const rows = await claimExpiredPendingUploads(
		leaseOwner,
		now,
		CLEANUP_PAGE_SIZE,
	);
	const admission =
		getDocsMintRuntimeOptions()?.attachmentStorageQuotaAdmission;
	let staged = 0;
	for (const original of rows) {
		try {
			const row = await advancePendingQuota(original, leaseOwner, admission);
			await withTenant(CLEANUP_ADMIN_TENANT, async (tx) => {
				await stagePendingAttachmentCleanup(tx, row, row.actorUserId, now);
			});
			staged += 1;
		} catch (error) {
			await recordPendingFailure(original, leaseOwner, error);
			logger.error(
				{ err: error, admissionId: original.id, key: original.storageKey },
				"Expired direct attachment cleanup failed; retaining admission",
			);
		}
	}
	if (staged > 0) await drainAttachmentStorageCleanupOutbox({ maxPages: 1 });
	return staged;
}

export function startAttachmentUploadCleanup(): { stop(): void } {
	let stopped = false;
	const run = () => {
		if (stopped) return;
		void cleanupExpiredAttachmentUploads()
			.then(() => drainAttachmentStorageCleanupOutbox({ maxPages: 1 }))
			.catch((error) => {
				logger.error({ err: error }, "Attachment storage recovery failed");
			});
	};
	queueMicrotask(run);
	const timer = setInterval(run, CLEANUP_INTERVAL_MS);
	timer.unref?.();
	return {
		stop() {
			stopped = true;
			clearInterval(timer);
		},
	};
}
