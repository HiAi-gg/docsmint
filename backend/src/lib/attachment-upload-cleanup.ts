import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { pendingAttachmentUploads } from "@hiai-docs/db/schema";
import {
	adminTenantContext,
	withTenant,
	ZERO_UUID,
} from "@hiai-docs/db/with-tenant";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { logger } from "./logger";
import { getDocsMintRuntimeOptions } from "./runtime-options";
import { BUCKET, storage } from "./storage";

const CLEANUP_PAGE_SIZE = 100;
const CLEANUP_INTERVAL_MS = 60_000;

export async function cleanupExpiredAttachmentUploads(): Promise<number> {
	const now = new Date();
	const staleConfirmation = new Date(now.getTime() - 5 * 60_000);
	const rows = await withTenant(adminTenantContext(ZERO_UUID), (tx) =>
		tx
			.select()
			.from(pendingAttachmentUploads)
			.where(
				and(
					lt(pendingAttachmentUploads.expiresAt, now),
					or(
						isNull(pendingAttachmentUploads.confirmingAt),
						lt(pendingAttachmentUploads.confirmingAt, staleConfirmation),
					),
				),
			)
			.orderBy(pendingAttachmentUploads.expiresAt, pendingAttachmentUploads.id)
			.limit(CLEANUP_PAGE_SIZE),
	);
	let cleaned = 0;
	const quotaAdmission =
		getDocsMintRuntimeOptions()?.attachmentStorageQuotaAdmission;
	for (const row of rows) {
		try {
			await storage.send(
				new DeleteObjectCommand({ Bucket: BUCKET, Key: row.storageKey }),
			);
			if (quotaAdmission && row.workspaceId && row.quotaReservationId) {
				await quotaAdmission.releaseReservation(
					{
						workspaceId: row.workspaceId,
						actorUserId: row.actorUserId,
						documentId: row.documentId,
						storageKey: row.storageKey,
						proposedSize: row.declaredSize,
						requestId: row.id,
						idempotencyKey: `attachment:${row.documentId}:${row.storageKey}`,
					},
					row.quotaReservationId,
				);
			}
			await withTenant(adminTenantContext(ZERO_UUID), (tx) =>
				tx
					.delete(pendingAttachmentUploads)
					.where(eq(pendingAttachmentUploads.id, row.id)),
			);
			cleaned += 1;
		} catch (error) {
			logger.error(
				{ err: error, admissionId: row.id, key: row.storageKey },
				"Expired direct attachment cleanup failed; retaining admission",
			);
		}
	}
	return cleaned;
}

export function startAttachmentUploadCleanup(): { stop(): void } {
	let stopped = false;
	const run = () => {
		if (stopped) return;
		void cleanupExpiredAttachmentUploads().catch((error) => {
			logger.error({ err: error }, "Expired direct attachment recovery failed");
		});
	};
	run();
	const timer = setInterval(run, CLEANUP_INTERVAL_MS);
	timer.unref?.();
	return {
		stop() {
			stopped = true;
			clearInterval(timer);
		},
	};
}
