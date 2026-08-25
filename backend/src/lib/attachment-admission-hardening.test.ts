import { expect, test } from "bun:test";
import { AttachmentQuotaError, isRetryableQuotaError } from "./runtime-options";

const cleanupSource = await Bun.file(
	new URL("./attachment-storage-cleanup.ts", import.meta.url),
).text();
const pendingSource = await Bun.file(
	new URL("./attachment-upload-cleanup.ts", import.meta.url),
).text();
const uploadRoute = await Bun.file(
	new URL("../api/routes/attachments.ts", import.meta.url),
).text();

test("quota errors distinguish retryable provider failures from terminal rejections", () => {
	expect(isRetryableQuotaError(new AttachmentQuotaError("busy", true))).toBe(
		true,
	);
	expect(
		isRetryableQuotaError(new AttachmentQuotaError("quota exceeded", false)),
	).toBe(false);
	expect(isRetryableQuotaError(new Error("quota rejected"))).toBe(false);
	expect(isRetryableQuotaError(new Error("HTTP 413 payload"))).toBe(false);
	expect(isRetryableQuotaError(new Error("ECONNRESET"))).toBe(true);
});

test("PUT and copy stage cleanup behind a write hold until activation", () => {
	expect(cleanupSource).toContain("export const STORAGE_WRITE_HOLD_MS");
	expect(cleanupSource).toContain("export function storageWriteHoldNotBefore");
	expect(cleanupSource).toContain(
		"export async function activateAttachmentStorageCleanup",
	);
	expect(cleanupSource).toContain("candidate.not_before <=");
	expect(uploadRoute).toContain("notBefore: storageWriteHoldNotBefore()");
	expect(uploadRoute).toContain("activateAttachmentStorageCleanup(");
	expect(uploadRoute).toContain('"uncommitted_upload"');
	expect(uploadRoute).toContain("cleanupSourceId");
});

test("cleanup skips live confirm leases and exact drain never uses a shared page", () => {
	expect(cleanupSource).toContain("pending.lease_owner LIKE 'confirm:%'");
	expect(cleanupSource).toContain(
		"export function drainExactAttachmentStorageCleanup",
	);
	expect(cleanupSource).toContain("sourceKind: dependencies.sourceKind");
	expect(cleanupSource).toContain("pageSize: 1");
	expect(pendingSource).toContain(
		'drainExactAttachmentStorageCleanup(\n\t\t\t"pending_upload",\n\t\t\toriginal.id',
	);
	expect(pendingSource).toContain("relockPendingAttachmentUploadForConfirm");
	expect(uploadRoute).toContain(
		"eq(pendingAttachmentUploads.leaseOwner, claimed.leaseOwner)",
	);
});

test("terminal quota cleanup retires the intent instead of retrying forever", () => {
	expect(cleanupSource).toContain("if (isRetryableQuotaError(error))");
	expect(cleanupSource).toContain(
		"Terminal quota cleanup rejection; retiring intent",
	);
	expect(cleanupSource).toContain("acknowledged.push(row.id)");
});

test("attachment DELETE re-checks category authorization after the pipeline lock", () => {
	const deleteHandler = uploadRoute.slice(
		uploadRoute.indexOf("// DELETE /api/attachments/:id"),
	);
	const lockIndex = deleteHandler.indexOf("acquireDocumentPipelineLock(");
	expect(lockIndex).toBeGreaterThan(-1);
	const afterLock = deleteHandler.slice(lockIndex);
	expect(afterLock).toContain("effectiveDocumentCategoryCondition(");
	expect(afterLock).toContain("isNull(documents.deletedAt)");
	expect(afterLock).toContain("tenantOwnerCondition(");
	expect(afterLock.indexOf("effectiveDocumentCategoryCondition(")).toBeLessThan(
		afterLock.indexOf('.for("update"'),
	);
});
