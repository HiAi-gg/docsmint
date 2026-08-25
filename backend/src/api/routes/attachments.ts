import {
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
	attachmentStorageCleanupOutbox,
	attachments,
	documents,
	folders,
	pendingAttachmentUploads,
} from "@hiai-docs/db/schema";
import type { TenantContext } from "@hiai-docs/db/with-tenant";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { nanoid } from "nanoid";
import {
	accountPurgeFencedResponse,
	acquireAccountPurgeFenceLocks,
	isAccountPurgeFenced,
	isAccountPurgeFencedError,
} from "../../lib/account-purge-fence";
import {
	activateAttachmentStorageCleanup,
	drainExactAttachmentStorageCleanup,
	stageAttachmentStorageCleanup,
	storageWriteHoldNotBefore,
} from "../../lib/attachment-storage-cleanup";
import {
	abandonClaimedPendingAttachmentUpload,
	abandonPendingAttachmentUploadByProof,
	type ClaimedPendingAttachmentUploadRow,
	claimPendingAttachmentUploadForConfirm,
	type PendingAttachmentUploadRow,
	releasePendingAttachmentConfirmLease,
	relockPendingAttachmentUploadForConfirm,
} from "../../lib/attachment-upload-cleanup";
import {
	attachmentUploadTokenHash,
	signAttachmentUploadToken,
	verifyAttachmentUploadToken,
} from "../../lib/attachment-upload-token";
import { config } from "../../lib/config";
import {
	canAccessContent,
	effectiveDocumentCategoryCondition,
	resolveContentAccess,
	tenantOwnerCondition,
} from "../../lib/content-access";
import { acquireDocumentPipelineLock } from "../../lib/document-pipeline-serialization";
import { logger } from "../../lib/logger";
import { fetchRemoteImage } from "../../lib/remote-image";
import {
	getDocsMintRuntimeOptions,
	isRetryableQuotaError,
} from "../../lib/runtime-options";
import {
	documentReferencesRemoteImage,
	resolveShareDocumentScope,
	shareTokenAccessForDocument,
	shareTokenReferencesAttachment,
	verifyShareScopePassword,
} from "../../lib/share-access";
import { BUCKET, storage, storagePublic } from "../../lib/storage";
import { withTenant } from "../../lib/with-tenant";
import {
	documentRateLimiter,
	rateLimitHeaders,
	writeRateLimiter,
} from "../middleware/rate-limit";

async function authorizeDocument(
	request: Request,
	documentId: string,
	action: "read" | "edit",
) {
	const access = await resolveContentAccess(request);
	if (access.ctx.role === "none" || !canAccessContent(access, action)) {
		return { access, authorized: false as const };
	}
	const row = await withTenant(access.ctx, async (tx) => {
		const [document] = await tx
			.select({
				id: documents.id,
				categoryId: documents.categoryId,
				folderCategoryId: folders.categoryId,
			})
			.from(documents)
			.leftJoin(folders, eq(folders.id, documents.folderId))
			.where(
				and(
					eq(documents.id, documentId),
					tenantOwnerCondition(
						documents.ownerId,
						documents.workspaceId,
						access.ctx,
					),
					isNull(documents.deletedAt),
					...(access.restricted
						? [
								access.categoryId
									? effectiveDocumentCategoryCondition(
											documents.categoryId,
											documents.folderId,
											access.ctx,
											access.categoryId,
										)
									: sql`false`,
							]
						: []),
				),
			)
			.limit(1);
		return document ?? null;
	});
	return {
		access,
		authorized: !!row,
		row,
	};
}

/**
 * Legacy upload limit — kept as a safety net for the in-process
 * POST /documents/:id/attachments endpoint that buffers the file in
 * memory. New uploads go through the presigned-URL flow (see below) which
 * is bounded by `ATTACHMENT_MAX_SIZE_BYTES` instead.
 */
const LEGACY_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Hard cap for presigned uploads — configurable via
 * `ATTACHMENT_MAX_SIZE_MB` (default 25 MB). Computed once at module
 * load so per-request checks stay cheap.
 */
const ATTACHMENT_MAX_SIZE_BYTES = config.ATTACHMENT_MAX_SIZE_MB * 1024 * 1024;

function attachmentKeyPrefix(
	ctx: { source?: "personal" | "external"; workspaceId?: string },
	userId: string,
	documentId: string,
): string {
	return ctx.source === "external" && ctx.workspaceId
		? `${ctx.workspaceId}/${userId}/${documentId}`
		: `${userId}/${documentId}`;
}

const PRESIGN_EXPIRY_SECONDS = config.ATTACHMENT_PRESIGN_EXPIRY_SECONDS;

const INTEGRITY_PROBE_BYTES = 8;

type BodyChunk = Uint8Array | Buffer | ArrayBuffer | ArrayBufferView | string;
type AsyncBody = AsyncIterable<BodyChunk>;

function attachmentQuotaContext(
	ctx: { workspaceId?: string },
	actorUserId: string,
	documentId: string,
	storageKey: string,
	proposedSize: number,
	requestId: string = crypto.randomUUID(),
	idempotencyKey: string = `attachment:${documentId}:${storageKey}`,
): Readonly<{
	workspaceId: string;
	actorUserId: string;
	documentId: string;
	storageKey: string;
	proposedSize: number;
	requestId: string;
	idempotencyKey: string;
}> | null {
	if (!config.DOCSMINT_WORKSPACE_ENABLED) return null;
	if (!ctx.workspaceId) return null;
	return Object.freeze({
		workspaceId: ctx.workspaceId,
		actorUserId,
		documentId,
		storageKey,
		proposedSize,
		requestId,
		idempotencyKey,
	});
}

type AttachmentQuotaAdmission = NonNullable<
	NonNullable<
		ReturnType<typeof getDocsMintRuntimeOptions>
	>["attachmentStorageQuotaAdmission"]
>;

function attachmentQuotaAdmission(set: {
	status?: number | string;
}): AttachmentQuotaAdmission | null | undefined {
	if (!config.DOCSMINT_WORKSPACE_ENABLED) return null;
	const admission =
		getDocsMintRuntimeOptions()?.attachmentStorageQuotaAdmission;
	if (!admission) {
		set.status = 503;
		return undefined;
	}
	return admission;
}

async function readStorageBody(body: unknown): Promise<Buffer> {
	if (body == null) {
		return Buffer.alloc(0);
	}
	if (body instanceof Buffer) {
		return body;
	}
	if (body instanceof ArrayBuffer) {
		return Buffer.from(new Uint8Array(body));
	}
	if (ArrayBuffer.isView(body)) {
		return Buffer.from(
			new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
		);
	}
	if (typeof body === "string") {
		return Buffer.from(body);
	}

	if (typeof (body as AsyncBody)[Symbol.asyncIterator] === "function") {
		const chunks: Uint8Array[] = [];
		for await (const chunk of body as AsyncBody) {
			if (Buffer.isBuffer(chunk)) {
				chunks.push(chunk);
			} else if (chunk instanceof Uint8Array) {
				chunks.push(chunk);
			} else if (chunk instanceof ArrayBuffer) {
				chunks.push(new Uint8Array(chunk));
			} else if (ArrayBuffer.isView(chunk)) {
				chunks.push(
					new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
				);
			} else if (typeof chunk === "string") {
				chunks.push(Buffer.from(chunk));
			} else {
				chunks.push(Buffer.from(String(chunk)));
			}
		}
		return Buffer.concat(chunks);
	}

	if (
		typeof (body as { transformToByteArray: () => Promise<Uint8Array> })
			.transformToByteArray === "function"
	) {
		const bytes = await (
			body as { transformToByteArray: () => Promise<Uint8Array> }
		).transformToByteArray();
		return Buffer.from(bytes);
	}

	if (
		typeof (body as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer ===
		"function"
	) {
		const bytes = await (
			body as { arrayBuffer: () => Promise<ArrayBuffer> }
		).arrayBuffer();
		return Buffer.from(new Uint8Array(bytes));
	}

	if (typeof (body as ReadableStream<BodyChunk>).getReader === "function") {
		const reader = (body as ReadableStream<BodyChunk>).getReader();
		const chunks: Uint8Array[] = [];
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value == null) continue;
			if (Buffer.isBuffer(value)) {
				chunks.push(value);
			} else if (value instanceof Uint8Array) {
				chunks.push(value);
			} else if (value instanceof ArrayBuffer) {
				chunks.push(new Uint8Array(value));
			} else if (ArrayBuffer.isView(value)) {
				chunks.push(
					new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
				);
			} else if (typeof value === "string") {
				chunks.push(Buffer.from(value));
			} else {
				chunks.push(Buffer.from(String(value)));
			}
		}
		return Buffer.concat(chunks);
	}

	return Buffer.from(String(body));
}

/**
 * Read the first few bytes of an uploaded object back from storage and
 * compare them to the source buffer. Returns true on match, false on
 * mismatch, and true (treated as success) if the readback itself fails
 * — we never want a transient readback error to reject a successful
 * upload, but we DO want to catch a real byte-level corruption in the
 * put → get round trip.
 */
async function verifyUploadIntegrity(
	source: Buffer,
	key: string,
): Promise<boolean> {
	const probeLen = Math.min(INTEGRITY_PROBE_BYTES, source.length);
	if (probeLen === 0) return true;
	const expected = source.subarray(0, probeLen);

	try {
		const response = await storage.send(
			new GetObjectCommand({
				Bucket: BUCKET,
				Key: key,
				Range: `bytes=0-${probeLen - 1}`,
			}),
		);
		const actual = await readStorageBody(response.Body);
		if (actual.length !== probeLen) {
			logger.warn(
				{ key, expected: probeLen, got: actual.length },
				"Integrity probe: length mismatch (readback skipped)",
			);
			return true;
		}
		if (!actual.equals(expected)) {
			logger.error(
				{
					key,
					expected: expected.toString("hex"),
					got: actual.toString("hex"),
				},
				"Integrity probe: byte mismatch — upload is corrupted",
			);
			return false;
		}
		return true;
	} catch (err) {
		logger.warn(
			{ err, key },
			"Integrity probe: readback failed (treated as success)",
		);
		return true;
	}
}

function uploadClaimsTenantContext(claims: {
	actorUserId: string;
	workspaceId: string | null;
}): TenantContext {
	return claims.workspaceId
		? {
				userId: claims.actorUserId,
				role: "user",
				workspaceId: claims.workspaceId,
				source: "external",
			}
		: { userId: claims.actorUserId, role: "user", source: "personal" };
}

async function getClientIp(request: Request): Promise<string> {
	return (
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
		request.headers.get("x-real-ip") ??
		"unknown"
	);
}

export const attachmentRoutes = new Elysia({ prefix: "/api" })

	// POST /api/documents/:id/attachments/presign
	//
	// Returns a presigned SeaweedFS PUT URL that the browser can upload to
	// directly. The actual file bytes never traverse this API process,
	// so the global body-size limit is irrelevant for attachment uploads.
	//
	// Request body (JSON):
	//   { filename: string, contentType: string, size: number }
	//
	// Response:
	//   { url: string, key: string, maxSize: number, expiresIn: number }
	.post(
		"/documents/:id/attachments/presign",
		async ({ params, request, body, set }) => {
			const ip = await getClientIp(request);
			const rl = await writeRateLimiter(ip);
			if (!rl.allowed) {
				set.status = 429;
				set.headers = rateLimitHeaders(0, rl.retryAfter);
				return { error: "Too many requests" };
			}
			set.headers = rateLimitHeaders(rl.remaining);

			const documentId = params.id;
			const authorization = await authorizeDocument(
				request,
				documentId,
				"edit",
			);
			if (authorization.access.ctx.role === "none") {
				set.status = 401;
				return { error: "Unauthorized" };
			}
			if (!authorization.authorized) {
				set.status = authorization.row ? 403 : 404;
				return {
					error: authorization.row ? "Forbidden" : "Document not found",
				};
			}
			const ctx = authorization.access.ctx;
			const userId = authorization.access.userId;

			const payload = body as
				| { filename?: unknown; contentType?: unknown; size?: unknown }
				| undefined;
			const filename =
				typeof payload?.filename === "string" ? payload.filename : "";
			const contentType =
				typeof payload?.contentType === "string" ? payload.contentType : "";
			const size = typeof payload?.size === "number" ? payload.size : -1;

			if (!filename || filename.length > 255) {
				set.status = 400;
				return { error: "filename must be a non-empty string ≤ 255 chars" };
			}
			if (!contentType.startsWith("image/")) {
				set.status = 415;
				return { error: "Only image files are allowed" };
			}
			if (!Number.isFinite(size) || size <= 0) {
				set.status = 400;
				return { error: "size must be a positive number" };
			}
			if (size > ATTACHMENT_MAX_SIZE_BYTES) {
				set.status = 413;
				return {
					error: `File too large. Maximum size: ${ATTACHMENT_MAX_SIZE_BYTES / 1024 / 1024}MB`,
				};
			}

			// Generate storage key. Reuse the existing naming shape so the
			// download route (GET /attachments/:id/raw) keeps working for
			// any old records created before presign was introduced.
			const ext = filename.split(".").pop() ?? "bin";
			const key = `${attachmentKeyPrefix(ctx, userId, documentId)}/${nanoid()}.${ext}`;
			const admissionId = crypto.randomUUID();
			const expiresAt = new Date(Date.now() + PRESIGN_EXPIRY_SECONDS * 1000);
			const quotaOperationKey = `attachment:${documentId}:${key}`;
			const presignLeaseOwner = `presign:${admissionId}`;
			const presignLeaseExpiresAt = new Date(Date.now() + 60_000);
			const uploadToken = await signAttachmentUploadToken({
				id: admissionId,
				documentId,
				actorUserId: userId,
				workspaceId: ctx.workspaceId ?? null,
				storageKey: key,
				expiresAt: expiresAt.getTime(),
			});
			const quotaContext = attachmentQuotaContext(
				ctx,
				userId,
				documentId,
				key,
				size,
				admissionId,
				quotaOperationKey,
			);
			const admission = attachmentQuotaAdmission(set);
			if (admission === undefined) {
				return { error: "Attachment storage quota admission is unavailable" };
			}
			if (config.DOCSMINT_WORKSPACE_ENABLED && !quotaContext) {
				set.status = 503;
				return {
					error: "Workspace context is required for attachment storage",
				};
			}
			let reservationId: string | undefined;
			try {
				// Persist the quota operation before the first external call. The
				// operation key makes reserve/recovery retries the same admission.
				await withTenant(ctx, async (tx) => {
					await tx.insert(pendingAttachmentUploads).values({
						id: admissionId,
						documentId,
						actorUserId: userId,
						workspaceId: ctx.workspaceId ?? null,
						storageKey: key,
						tokenHash: attachmentUploadTokenHash(uploadToken),
						filename,
						mimeType: contentType,
						declaredSize: size,
						quotaOperationKey,
						quotaState: admission ? "reserve_pending" : "not_required",
						leaseOwner: presignLeaseOwner,
						leaseExpiresAt: presignLeaseExpiresAt,
						expiresAt,
					});
				});
				if (admission && quotaContext) {
					try {
						reservationId = (await admission.reserve(quotaContext)).id;
					} catch (error) {
						const retryable = isRetryableQuotaError(error);
						await withTenant(ctx, (tx) =>
							tx
								.update(pendingAttachmentUploads)
								.set({
									leaseOwner: null,
									leaseExpiresAt: new Date(),
									lastError: retryable
										? "quota_reserve_retryable"
										: "quota_reserve_terminal",
									quotaState: retryable ? "reserve_pending" : "not_required",
								})
								.where(eq(pendingAttachmentUploads.id, admissionId)),
						).catch(() => undefined);
						logger.warn(
							{ err: error, documentId, retryable },
							"Attachment storage quota reservation rejected",
						);
						set.status = retryable ? 503 : 413;
						return {
							error: retryable
								? "Storage quota admission is unavailable"
								: "Storage quota exceeded",
						};
					}
					const reservedRows = await withTenant(ctx, (tx) =>
						tx
							.update(pendingAttachmentUploads)
							.set({
								quotaReservationId: reservationId,
								quotaState: "reserved",
							})
							.where(
								and(
									eq(pendingAttachmentUploads.id, admissionId),
									eq(pendingAttachmentUploads.leaseOwner, presignLeaseOwner),
								),
							)
							.returning({ id: pendingAttachmentUploads.id }),
					);
					if (reservedRows.length !== 1)
						throw new Error("attachment_admission_lease_lost");
				}
				const url = await getSignedUrl(
					storagePublic,
					new PutObjectCommand({ Bucket: BUCKET, Key: key }),
					{ expiresIn: PRESIGN_EXPIRY_SECONDS },
				);
				const issuedRows = await withTenant(ctx, (tx) =>
					tx
						.update(pendingAttachmentUploads)
						.set({
							urlIssuedAt: new Date(),
							leaseOwner: null,
							leaseExpiresAt: null,
						})
						.where(
							and(
								eq(pendingAttachmentUploads.id, admissionId),
								eq(pendingAttachmentUploads.leaseOwner, presignLeaseOwner),
							),
						)
						.returning({ id: pendingAttachmentUploads.id }),
				);
				if (issuedRows.length !== 1)
					throw new Error("attachment_admission_lease_lost");
				return {
					url,
					key,
					uploadToken,
					// This opaque value is created by the server-side admission
					// provider. It must be returned unchanged to confirm so the
					// original reservation, rather than a second reservation, is
					// finalized after the storage HEAD check.
					...(reservationId ? { quotaReservationId: reservationId } : {}),
					maxSize: ATTACHMENT_MAX_SIZE_BYTES,
					expiresIn: PRESIGN_EXPIRY_SECONDS,
				};
			} catch (err) {
				// The pending quota saga remains authoritative. Recovery resumes the
				// exact operation; no direct quota or S3 cleanup occurs in this catch.
				await withTenant(ctx, (tx) =>
					tx
						.update(pendingAttachmentUploads)
						.set({ leaseOwner: null, leaseExpiresAt: new Date() })
						.where(eq(pendingAttachmentUploads.id, admissionId)),
				).catch(() => undefined);
				if (isAccountPurgeFencedError(err)) {
					set.status = 409;
					return accountPurgeFencedResponse();
				}
				logger.error({ err, key }, "Failed to presign attachment upload");
				set.status = 500;
				return { error: "Failed to generate upload URL" };
			}
		},
	)

	// POST /api/documents/:id/attachments/confirm
	//
	// Called by the client AFTER the PUT to the presigned URL succeeds.
	// Verifies the object exists in SeaweedFS with the expected size before
	// inserting the database row, so we never record a row for an upload
	// that didn't actually land.
	//
	// Request body (JSON):
	//   { key: string, filename: string, contentType: string, size: number }
	.post(
		"/documents/:id/attachments/confirm",
		async ({ params, request, body, set }) => {
			const documentId = params.id;
			const payload = body as
				| {
						key?: unknown;
						uploadToken?: unknown;
						filename?: unknown;
						contentType?: unknown;
						size?: unknown;
						quotaReservationId?: unknown;
				  }
				| undefined;
			const key = typeof payload?.key === "string" ? payload.key : "";
			const uploadToken =
				typeof payload?.uploadToken === "string" ? payload.uploadToken : "";
			const filename =
				typeof payload?.filename === "string" ? payload.filename : "";
			const contentType =
				typeof payload?.contentType === "string" ? payload.contentType : "";
			const size = typeof payload?.size === "number" ? payload.size : -1;
			const quotaReservationId =
				typeof payload?.quotaReservationId === "string"
					? payload.quotaReservationId
					: "";

			if (!key || !uploadToken) {
				set.status = 400;
				return { error: "key and uploadToken are required" };
			}
			const claims = await verifyAttachmentUploadToken(uploadToken);
			if (
				!claims ||
				claims.documentId !== documentId ||
				claims.storageKey !== key
			) {
				set.status = 400;
				return { error: "uploadToken does not match this upload" };
			}
			const claimCtx = uploadClaimsTenantContext(claims);
			const authorization = await authorizeDocument(
				request,
				documentId,
				"edit",
			);
			const requestIsAuthenticated = authorization.access.ctx.role !== "none";
			if (
				requestIsAuthenticated &&
				(authorization.access.userId !== claims.actorUserId ||
					(authorization.access.ctx.workspaceId ?? null) !== claims.workspaceId)
			) {
				// A valid token presented by a different actor/workspace is not cleanup
				// authority. In particular, never delete the token owner's object here.
				set.status = 404;
				return { error: "Upload not found" };
			}

			const tokenHash = attachmentUploadTokenHash(uploadToken);
			let claimed: ClaimedPendingAttachmentUploadRow | null;
			try {
				claimed = await claimPendingAttachmentUploadForConfirm(claimCtx, {
					id: claims.id,
					documentId,
					storageKey: key,
					tokenHash,
				});
			} catch (error) {
				if (!isAccountPurgeFencedError(error)) throw error;
				await abandonPendingAttachmentUploadByProof(claimCtx, {
					id: claims.id,
					documentId,
					storageKey: key,
					tokenHash,
				});
				set.status = 409;
				return accountPurgeFencedResponse();
			}
			if (!claimed) {
				const [existing] = await withTenant(claimCtx, (tx) =>
					tx
						.select()
						.from(attachments)
						.where(eq(attachments.storageKey, key))
						.limit(1),
				);
				if (existing && authorization.authorized) {
					set.status = 201;
					return {
						id: existing.id,
						filename: existing.filename,
						mimeType: existing.mimeType,
						size: existing.size,
						url: `/api/attachments/${existing.id}/raw`,
					};
				}
				await drainExactAttachmentStorageCleanup(
					"pending_upload",
					claims.id,
				).catch(() => undefined);
				set.status = existing || !authorization.row ? 404 : 409;
				return {
					error: existing
						? "Document not found"
						: "Upload is already being confirmed or was cleaned",
				};
			}

			const quotaContext = attachmentQuotaContext(
				claimCtx,
				claims.actorUserId,
				documentId,
				key,
				claimed.declaredSize,
				claimed.id,
				claimed.quotaOperationKey,
			);
			const admission = attachmentQuotaAdmission(set);
			let confirmed = false;
			let abandonRejectedConfirm = true;
			let cleanupRow: PendingAttachmentUploadRow = claimed;
			try {
				const ip = await getClientIp(request);
				const rl = await writeRateLimiter(ip);
				if (!rl.allowed) {
					set.status = 429;
					set.headers = rateLimitHeaders(0, rl.retryAfter);
					return { error: "Too many requests" };
				}
				set.headers = rateLimitHeaders(rl.remaining);
				if (!requestIsAuthenticated || !authorization.authorized) {
					set.status = authorization.row ? 403 : 404;
					return {
						error: authorization.row ? "Forbidden" : "Document not found",
					};
				}
				if (
					!filename ||
					filename.length > 255 ||
					filename !== claimed.filename
				) {
					set.status = 400;
					return { error: "filename does not match the admitted upload" };
				}
				if (
					!contentType.startsWith("image/") ||
					contentType !== claimed.mimeType
				) {
					set.status = 415;
					return { error: "Only the admitted image content type is allowed" };
				}
				if (!Number.isFinite(size) || size !== claimed.declaredSize) {
					set.status = 400;
					return { error: "size does not match the admitted upload" };
				}
				if (admission === undefined) {
					return { error: "Attachment storage quota admission is unavailable" };
				}
				if (config.DOCSMINT_WORKSPACE_ENABLED && !quotaContext) {
					set.status = 503;
					return {
						error: "Workspace context is required for attachment storage",
					};
				}
				if (claimed.quotaReservationId !== (quotaReservationId || null)) {
					set.status = 400;
					return {
						error: "quotaReservationId does not match the admitted upload",
					};
				}

				let headOutput: { ContentLength?: number };
				try {
					headOutput = await storage.send(
						new HeadObjectCommand({ Bucket: BUCKET, Key: key }),
					);
				} catch (err) {
					logger.warn({ err, key }, "Confirm failed: object not in storage");
					set.status = 409;
					return { error: "Upload not found in storage — please retry upload" };
				}
				const storedSize = headOutput.ContentLength;
				if (
					typeof storedSize !== "number" ||
					!Number.isFinite(storedSize) ||
					storedSize <= 0
				) {
					set.status = 409;
					return { error: "Upload size could not be verified" };
				}
				if (storedSize > ATTACHMENT_MAX_SIZE_BYTES) {
					set.status = 413;
					return {
						error: `Uploaded file exceeds the ${config.ATTACHMENT_MAX_SIZE_MB}MB limit`,
					};
				}
				if (admission && quotaContext && claimed.quotaReservationId) {
					try {
						const finalizeRows = await withTenant(claimCtx, (tx) =>
							tx
								.update(pendingAttachmentUploads)
								.set({
									quotaState: "finalize_pending",
									actualSize: storedSize,
								})
								.where(
									and(
										eq(pendingAttachmentUploads.id, claimed.id),
										eq(pendingAttachmentUploads.leaseOwner, claimed.leaseOwner),
									),
								)
								.returning({ id: pendingAttachmentUploads.id }),
						);
						if (finalizeRows.length !== 1)
							throw new Error("attachment_admission_lease_lost");
						cleanupRow = {
							...cleanupRow,
							quotaState: "finalize_pending",
							actualSize: storedSize,
						};
						await admission.finalize(quotaContext, {
							reservationId: claimed.quotaReservationId,
							actualSize: storedSize,
						});
						const committedRows = await withTenant(claimCtx, (tx) =>
							tx
								.update(pendingAttachmentUploads)
								.set({ quotaState: "committed" })
								.where(
									and(
										eq(pendingAttachmentUploads.id, claimed.id),
										eq(pendingAttachmentUploads.leaseOwner, claimed.leaseOwner),
									),
								)
								.returning({ id: pendingAttachmentUploads.id }),
						);
						if (committedRows.length !== 1)
							throw new Error("attachment_admission_lease_lost");
						cleanupRow = { ...cleanupRow, quotaState: "committed" };
					} catch (error) {
						const retryable = isRetryableQuotaError(error);
						logger.error(
							{ err: error, documentId, retryable },
							"Attachment storage quota finalization failed",
						);
						if (retryable) abandonRejectedConfirm = false;
						set.status = retryable ? 503 : 413;
						return {
							error: retryable
								? "Attachment storage quota finalization failed"
								: "Storage quota exceeded",
						};
					}
				}

				const created = await withTenant(claimCtx, async (tx) => {
					await tx.execute(
						sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
					);
					const activeClaim = await relockPendingAttachmentUploadForConfirm(
						tx,
						{
							id: claimed.id,
							leaseOwner: claimed.leaseOwner,
							actorUserId: claims.actorUserId,
						},
					);
					if (!activeClaim) return null;
					const [raced] = await tx
						.select()
						.from(attachments)
						.where(eq(attachments.storageKey, key))
						.limit(1);
					let result = raced;
					if (!result) {
						[result] = await tx
							.insert(attachments)
							.values({
								documentId,
								workspaceId: claims.workspaceId,
								uploadedBy: claims.actorUserId,
								filename: claimed.filename,
								mimeType: claimed.mimeType,
								size: storedSize,
								storageKey: key,
							})
							.onConflictDoNothing({ target: attachments.storageKey })
							.returning();
					}
					if (!result) {
						[result] = await tx
							.select()
							.from(attachments)
							.where(eq(attachments.storageKey, key))
							.limit(1);
					}
					if (!result) return null;
					await tx
						.delete(pendingAttachmentUploads)
						.where(
							and(
								eq(pendingAttachmentUploads.id, claims.id),
								eq(pendingAttachmentUploads.tokenHash, tokenHash),
								eq(pendingAttachmentUploads.leaseOwner, claimed.leaseOwner),
							),
						);
					return result;
				});
				if (!created) {
					set.status = 500;
					return { error: "Failed to save attachment record" };
				}
				confirmed = true;
				set.status = 201;
				return {
					id: created.id,
					filename: created.filename,
					mimeType: created.mimeType,
					size: created.size,
					url: `/api/attachments/${created.id}/raw`,
				};
			} catch (err) {
				if (isAccountPurgeFencedError(err)) {
					set.status = 409;
					return accountPurgeFencedResponse();
				}
				logger.error({ err, key }, "Confirm failed");
				set.status = 500;
				return { error: "Failed to save attachment record" };
			} finally {
				if (!confirmed && abandonRejectedConfirm) {
					await abandonClaimedPendingAttachmentUpload(
						claimCtx,
						cleanupRow,
					).catch((error) => {
						logger.error(
							{ err: error, admissionId: claimed.id, key },
							"Failed to stage rejected attachment cleanup",
						);
					});
				} else if (!confirmed) {
					await releasePendingAttachmentConfirmLease(claimCtx, {
						id: claimed.id,
						leaseOwner: claimed.leaseOwner,
					}).catch(() => undefined);
				}
			}
		},
	)

	// POST /api/documents/:id/attachments — Legacy in-process upload
	//
	// Kept for backward compatibility (e.g. CLI / API-key clients that
	// can't reach storage directly). New uploads from the editor go through
	// the presigned flow above; this endpoint caps at 10 MB to match its
	// historical behavior and to keep the per-request memory footprint
	// bounded.
	.post("/documents/:id/attachments", async ({ params, request, set }) => {
		const ip = await getClientIp(request);
		const rl = await writeRateLimiter(ip);
		if (!rl.allowed) {
			set.status = 429;
			set.headers = rateLimitHeaders(0, rl.retryAfter);
			return { error: "Too many requests" };
		}
		set.headers = rateLimitHeaders(rl.remaining);

		const authorization = await authorizeDocument(request, params.id, "edit");
		if (authorization.access.ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		if (!authorization.authorized) {
			set.status = authorization.row ? 403 : 404;
			return { error: authorization.row ? "Forbidden" : "Document not found" };
		}
		const ctx = authorization.access.ctx;
		const userId = authorization.access.userId;
		// The legacy buffered path has no durable presign identity. Under
		// workspace tenancy reject it rather than permit an unmetered bypass;
		// clients must use the admission-aware presign/confirm lifecycle.
		if (config.DOCSMINT_WORKSPACE_ENABLED) {
			set.status = 503;
			return {
				error:
					"Legacy attachment uploads are unavailable with workspace storage enforcement",
			};
		}

		const documentId = params.id;

		// Parse multipart form data
		let file: File | null;
		try {
			const formData = await request.formData();
			file = formData.get("file") as File | null;
		} catch {
			set.status = 400;
			return { error: "Failed to parse form data" };
		}

		if (!file) {
			set.status = 400;
			return { error: "No file provided" };
		}

		if (!file.type.startsWith("image/")) {
			set.status = 415;
			return { error: "Only image files are allowed" };
		}

		if (file.size > LEGACY_MAX_FILE_SIZE) {
			set.status = 413;
			return {
				error: `File too large. Maximum size: ${LEGACY_MAX_FILE_SIZE / 1024 / 1024}MB. New uploads should use the presigned URL flow.`,
			};
		}

		// Generate storage key
		const ext = file.name.split(".").pop() ?? "bin";
		const key = `${attachmentKeyPrefix(ctx, userId, documentId)}/${nanoid()}.${ext}`;
		const cleanupSourceId = crypto.randomUUID();

		try {
			// Commit exact cleanup authority before the irreversible PUT. A fence or
			// process crash after this point can never make the key undiscoverable.
			await withTenant(ctx, (tx) =>
				stageAttachmentStorageCleanup(tx, {
					sourceKind: "uncommitted_upload",
					sourceId: cleanupSourceId,
					storageKey: key,
					documentId,
					actorUserId: userId,
					ownerUserId: userId,
					requestedByUserId: userId,
					workspaceId: null,
					size: file.size,
					quotaOperationKey: `attachment:${documentId}:${key}`,
					quotaReleaseKind: "none",
					notBefore: storageWriteHoldNotBefore(),
				}),
			);
			// Upload to SeaweedFS
			const arrayBuffer = await file.arrayBuffer();
			const buffer = Buffer.from(arrayBuffer);
			await storage.send(
				new PutObjectCommand({
					Bucket: BUCKET,
					Key: key,
					Body: buffer,
					ContentType: file.type,
					ContentLength: file.size,
				}),
			);

			// Defensive integrity check: read the first 8 bytes back from
			// storage and compare to the source buffer. The current pipeline
			// (Bun Request.formData() + Buffer.from(arrayBuffer) +
			// PutObjectCommand) is binary-safe — empirical round-trip tests
			// confirm no corruption — but a non-text-mode regression in any
			// of those layers would surface as 0x89 being replaced with
			// 0xEF 0xBF 0xBD (UTF-8 U+FFFD) for PNG/JPEG high-bit bytes.
			// The check is best-effort: a readback failure (e.g. transient
			// network blip) logs a warning but does not fail the upload.
			const integrityOk = await verifyUploadIntegrity(buffer, key);
			if (!integrityOk) {
				await withTenant(ctx, (tx) =>
					activateAttachmentStorageCleanup(
						tx,
						"uncommitted_upload",
						cleanupSourceId,
					),
				);
				await drainExactAttachmentStorageCleanup(
					"uncommitted_upload",
					cleanupSourceId,
				);
				set.status = 500;
				return { error: "Upload integrity check failed" };
			}

			// Insert attachment row
			const created = await withTenant(ctx, async (tx) => {
				const [row] = await tx
					.insert(attachments)
					.values({
						documentId,
						workspaceId: ctx.workspaceId ?? null,
						uploadedBy: userId,
						filename: file.name,
						mimeType: file.type,
						size: file.size,
						storageKey: key,
					})
					.returning();
				await tx
					.delete(attachmentStorageCleanupOutbox)
					.where(
						and(
							eq(
								attachmentStorageCleanupOutbox.sourceKind,
								"uncommitted_upload",
							),
							eq(attachmentStorageCleanupOutbox.sourceId, cleanupSourceId),
						),
					);
				return row ?? null;
			});

			if (!created) {
				await withTenant(ctx, (tx) =>
					activateAttachmentStorageCleanup(
						tx,
						"uncommitted_upload",
						cleanupSourceId,
					),
				);
				await drainExactAttachmentStorageCleanup(
					"uncommitted_upload",
					cleanupSourceId,
				);
				set.status = 500;
				return { error: "Failed to save attachment record" };
			}
			// Return a stable, same-origin streaming URL instead of a 24h
			// presigned URL. The presigned URL would expire (breaking images
			// embedded in saved documents) and would not be reachable from the
			// public share view. `/api/attachments/:id/raw` is permanent and
			// public.
			set.status = 201;
			return {
				id: created.id,
				filename: created.filename,
				mimeType: created.mimeType,
				size: created.size,
				url: `/api/attachments/${created.id}/raw`,
			};
		} catch (err) {
			await withTenant(ctx, (tx) =>
				activateAttachmentStorageCleanup(
					tx,
					"uncommitted_upload",
					cleanupSourceId,
				),
			).catch(() => undefined);
			await drainExactAttachmentStorageCleanup(
				"uncommitted_upload",
				cleanupSourceId,
			).catch(() => undefined);
			if (isAccountPurgeFencedError(err)) {
				set.status = 409;
				return accountPurgeFencedResponse();
			}
			logger.error({ err }, "Failed to upload attachment");
			set.status = 500;
			return { error: "Failed to upload attachment" };
		}
	})

	// GET /api/documents/:id/attachments — List attachments for a document
	.get("/documents/:id/attachments", async ({ params, set, request }) => {
		const authorization = await authorizeDocument(request, params.id, "read");
		if (authorization.access.ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		if (!authorization.authorized) {
			set.status = authorization.row ? 403 : 404;
			return { error: authorization.row ? "Forbidden" : "Document not found" };
		}
		const ctx = authorization.access.ctx;
		const _userId = authorization.access.userId;

		const documentId = params.id;

		// Verify document exists and user owns it
		const result = await withTenant(ctx, async (tx) => {
			const [doc] = await tx
				.select({ id: documents.id })
				.from(documents)
				.where(
					and(
						eq(documents.id, documentId),
						...(ctx.source === "external"
							? [
									tenantOwnerCondition(
										documents.ownerId,
										documents.workspaceId,
										ctx,
									),
								]
							: []),
					),
				)
				.limit(1);
			if (!doc) {
				return null;
			}
			const rows = await tx
				.select()
				.from(attachments)
				.where(eq(attachments.documentId, documentId));

			// Stable same-origin streaming URLs (see POST handler note).
			return rows.map((row) => ({
				id: row.id,
				filename: row.filename,
				mimeType: row.mimeType,
				size: row.size,
				url: `/api/attachments/${row.id}/raw`,
			}));
		});

		if (!result) {
			set.status = 404;
			return { error: "Document not found" };
		}
		return { items: result };
	})

	// DELETE /api/attachments/:id — Remove an attachment
	//
	// Verifies the caller owns the document the attachment is attached to
	// via an inner join, then removes the storage object and the DB row.
	// Object removal is best-effort: a missing object (e.g. a row that
	// was inserted by `confirm` after a partial PUT) still proceeds to
	// delete the DB row so the user is not left with a phantom record.
	//
	// Response:
	//   200 { success: true }
	.delete("/attachments/:id", async ({ params, request, set }) => {
		const ip = await getClientIp(request);
		const rl = await writeRateLimiter(ip, request);
		if (!rl.allowed) {
			set.status = 429;
			set.headers = rateLimitHeaders(0, rl.retryAfter);
			return { error: "Too many requests" };
		}
		set.headers = rateLimitHeaders(rl.remaining);

		const access = await resolveContentAccess(request);
		const ctx = access.ctx;
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		if (!canAccessContent(access, "edit")) {
			set.status = 403;
			return { error: "Forbidden" };
		}
		if (await isAccountPurgeFenced(ctx.userId)) {
			set.status = 409;
			return accountPurgeFencedResponse();
		}
		const userId = ctx.userId;

		const attachmentId = params.id;

		// Look up the attachment with its owning document so we can
		// distinguish three cases:
		//   - row missing entirely (404)
		//   - row exists but caller is not the owner (403)
		//   - row exists and caller owns it (proceed to delete)
		// The inner join is intentional: a row whose `documentId` points
		// at a deleted document is dropped from the result set, which is
		// fine because the FK is `ON DELETE CASCADE` and the row should
		// already be gone too.
		const row = await withTenant(ctx, async (tx) => {
			const [r] = await tx
				.select({
					id: attachments.id,
					documentId: attachments.documentId,
					storageKey: attachments.storageKey,
					size: attachments.size,
					uploadedBy: attachments.uploadedBy,
					workspaceId: attachments.workspaceId,
					ownerId: documents.ownerId,
					categoryId: documents.categoryId,
					folderCategoryId: folders.categoryId,
				})
				.from(attachments)
				.innerJoin(documents, eq(documents.id, attachments.documentId))
				.leftJoin(folders, eq(folders.id, documents.folderId))
				.where(
					and(
						eq(attachments.id, attachmentId),
						...(ctx.source === "external"
							? [
									tenantOwnerCondition(
										documents.ownerId,
										documents.workspaceId,
										ctx,
									),
								]
							: []),
						isNull(documents.deletedAt),
						...(access.restricted
							? [
									access.categoryId
										? effectiveDocumentCategoryCondition(
												documents.categoryId,
												documents.folderId,
												ctx,
												access.categoryId,
											)
										: sql`false`,
								]
							: []),
					),
				)
				.limit(1);
			return r ?? null;
		});

		if (!row) {
			set.status = 404;
			return { error: "Attachment not found" };
		}
		if (ctx.source !== "external" && row.ownerId !== userId) {
			set.status = 403;
			return { error: "Forbidden" };
		}
		try {
			const deleted = await withTenant(ctx, async (tx) => {
				await acquireDocumentPipelineLock(tx, row.documentId);
				const [current] = await tx
					.select({
						id: attachments.id,
						documentId: attachments.documentId,
						storageKey: attachments.storageKey,
						size: attachments.size,
						uploadedBy: attachments.uploadedBy,
						workspaceId: attachments.workspaceId,
						ownerId: documents.ownerId,
					})
					.from(attachments)
					.innerJoin(documents, eq(documents.id, attachments.documentId))
					.where(eq(attachments.id, attachmentId))
					.limit(1)
					.for("update", { of: documents });
				if (!current) return null;
				await acquireAccountPurgeFenceLocks(tx, [
					ctx.userId,
					current.uploadedBy,
					...(current.workspaceId ? [] : [current.ownerId]),
				]);
				await stageAttachmentStorageCleanup(tx, {
					sourceKind: "attachment",
					sourceId: current.id,
					storageKey: current.storageKey,
					documentId: current.documentId,
					actorUserId: current.uploadedBy,
					ownerUserId: current.ownerId,
					requestedByUserId: ctx.userId,
					workspaceId: current.workspaceId,
					size: current.size,
					quotaOperationKey: `attachment:${current.documentId}:${current.storageKey}`,
					quotaReleaseKind: current.workspaceId ? "committed" : "none",
				});
				const [removed] = await tx
					.delete(attachments)
					.where(eq(attachments.id, attachmentId))
					.returning({ id: attachments.id });
				return removed ?? null;
			});
			if (!deleted) {
				set.status = 404;
				return { error: "Attachment not found" };
			}
		} catch (error) {
			if (isAccountPurgeFencedError(error)) {
				set.status = 409;
				return accountPurgeFencedResponse();
			}
			throw error;
		}
		await drainExactAttachmentStorageCleanup("attachment", attachmentId).catch(
			(error) => {
				logger.error(
					{ err: error, attachmentId },
					"Attachment cleanup retained for recovery",
				);
			},
		);

		return { success: true };
	})

	// GET /api/attachments/:id/raw — Stream attachment bytes (gated).
	//
	// Auth model: this endpoint was previously public (relying on UUID
	// unguessability) so that images embedded inside shared documents
	// would render in the anonymous share view. With UUIDs leaked via
	// referer headers, browser caches, and external link previews, the
	// pure-UUID model is not enough — a holder of any embedded URL gets
	// permanent read access to that binary even after the share is
	// revoked.
	//
	// The gate is therefore hybrid:
	//   1. Authenticated caller (session cookie OR `Authorization:
	//      Bearer <api-key>`) → ownership check via the joined document.
	//      200 if owner, 403 if the attachment exists but belongs to a
	//      different user, 404 if no such attachment.
	//   2. Anonymous caller with `x-share-token: <token>` header → look
	//      up the share link, check expiry, then check whether the
	//      attachment's document is the shared doc or sits under the
	//      shared folder. 200 on a match, 401 on a missing / expired /
	//      mismatched token.
	//   3. No session AND no share token → 401, regardless of whether
	//      the attachment exists. Returning 404 here would let an
	//      unauthenticated probe distinguish "unknown id" from "exists
	//      but blocked", so the auth check runs before the row lookup.
	//
	// Streaming the bytes after the gate uses the same buffered path the
	// original public endpoint used. We don't pipe directly into the
	// Response stream so the existing `GetObjectCommand` mock in tests
	// keeps working without needing a second streaming implementation.
	.get("/attachments/:id/raw", async ({ params, request, set }) => {
		try {
			// Auth gate first — see comment above for why ordering
			// matters here. We accept either an authenticated session
			// OR a share-token header; the lookup below differs by
			// which path we took.
			const access = await resolveContentAccess(request);
			const ctx = access.ctx;
			const shareToken =
				ctx.role === "none" ? request.headers.get("x-share-token") : null;
			if (ctx.role === "none" && !shareToken) {
				set.status = 401;
				return { error: "Authentication required" };
			}

			// Use admin context for the lookup so RLS lets us find any
			// attachment row (the auth gate above is the security boundary,
			// not the RLS policy). The owner-vs-anonymous decision is
			// made after we know who the row belongs to.
			const lookupCtx =
				ctx.source === "external"
					? ctx
					: { userId: ctx.userId, role: "admin" as const };
			const row = await withTenant(lookupCtx, async (tx) => {
				const [r] = await tx
					.select({
						id: attachments.id,
						documentId: attachments.documentId,
						mimeType: attachments.mimeType,
						storageKey: attachments.storageKey,
						ownerId: documents.ownerId,
						categoryId: documents.categoryId,
						folderCategoryId: folders.categoryId,
					})
					.from(attachments)
					.innerJoin(documents, eq(documents.id, attachments.documentId))
					.leftJoin(folders, eq(folders.id, documents.folderId))
					.where(
						and(
							eq(attachments.id, params.id),
							isNull(documents.deletedAt),
							...(ctx.source === "external"
								? [
										tenantOwnerCondition(
											documents.ownerId,
											documents.workspaceId,
											ctx,
										),
									]
								: []),
							...(access.restricted
								? [
										access.categoryId
											? effectiveDocumentCategoryCondition(
													documents.categoryId,
													documents.folderId,
													ctx,
													access.categoryId,
												)
											: sql`false`,
									]
								: []),
						),
					)
					.limit(1);
				return r ?? null;
			});

			if (!row) {
				set.status = 404;
				return { error: "Attachment not found" };
			}

			if (ctx.role !== "none") {
				if (
					!canAccessContent(access, "read") ||
					(ctx.source !== "external" && row.ownerId !== ctx.userId)
				) {
					set.status = 403;
					return { error: "Forbidden" };
				}
			} else if (shareToken) {
				let verdict = await shareTokenAccessForDocument(
					lookupCtx,
					row.documentId,
					shareToken,
				);
				if (
					verdict === "no-access" &&
					(await shareTokenReferencesAttachment(
						lookupCtx,
						shareToken,
						row.id,
						row.ownerId,
					))
				) {
					verdict = "granted";
				}
				if (verdict !== "granted") {
					// "missing", "expired", and "no-access" all collapse
					// to 401 with the same generic message — leaking
					// which one fired would let an unauthenticated
					// caller enumerate live share tokens by comparing
					// 401 ("missing") vs 401 ("expired") vs 401
					// ("no-access"). The internal log line below
					// preserves the distinction for operators.
					logger.warn(
						{
							attachmentId: row.id,
							documentId: row.documentId,
							verdict,
						},
						"Share-token access denied for attachment",
					);
					set.status = 401;
					return { error: "Authentication required" };
				}
				const shareScope = await resolveShareDocumentScope(
					lookupCtx,
					shareToken,
				);
				if (
					!shareScope ||
					!(await verifyShareScopePassword(
						shareScope,
						request.headers.get("x-share-password"),
					))
				) {
					set.status = 401;
					return { error: "Authentication required" };
				}
			}

			const response = await storage.send(
				new GetObjectCommand({ Bucket: BUCKET, Key: row.storageKey }),
			);
			const buffer = await readStorageBody(response.Body);
			return new Response(new Uint8Array(buffer), {
				headers: {
					"Content-Type": row.mimeType,
					// `private` so shared caches (CDNs, proxies) cannot
					// serve the auth-gated bytes to a different user
					// hitting the same URL. The UUID is unique per
					// attachment so `immutable` would also be safe, but
					// `private` first signals that the response varies
					// per authenticated caller.
					"Cache-Control": "private, max-age=3600, immutable",
				},
			});
		} catch (err) {
			logger.error({ err }, "Failed to stream attachment");
			set.status = 500;
			return { error: "Failed to stream attachment" };
		}
	})
	// Same-origin bridge used only by DOCX export. The requested URL must be
	// present in a document the caller can read; the fetcher additionally
	// rejects private networks, redirects to private networks, non-images,
	// oversized responses, and slow upstreams.
	.get("/attachments/remote-image", async ({ request, set }) => {
		try {
			const rateLimit = await documentRateLimiter(
				await getClientIp(request),
				request,
			);
			if (!rateLimit.allowed) {
				set.status = 429;
				set.headers = rateLimitHeaders(0, rateLimit.retryAfter);
				return { error: "Too many requests" };
			}
			set.headers = rateLimitHeaders(rateLimit.remaining);
			const requestUrl = new URL(request.url);
			const documentId = requestUrl.searchParams.get("documentId")?.trim();
			const source = requestUrl.searchParams.get("url")?.trim();
			if (!documentId || !source || source.length > 4096) {
				set.status = 400;
				return { error: "documentId and a valid image URL are required" };
			}

			const access = await resolveContentAccess(request);
			const ctx = access.ctx;
			const shareToken =
				ctx.role === "none" ? request.headers.get("x-share-token") : null;
			if (ctx.role === "none" && !shareToken) {
				set.status = 401;
				return { error: "Authentication required" };
			}
			const lookupCtx =
				ctx.source === "external"
					? ctx
					: { userId: ctx.userId, role: "admin" as const };
			const document = await withTenant(lookupCtx, async (tx) => {
				const [row] = await tx
					.select({
						ownerId: documents.ownerId,
						content: documents.content,
						contentJson: documents.contentJson,
						categoryId: documents.categoryId,
						folderCategoryId: folders.categoryId,
					})
					.from(documents)
					.leftJoin(folders, eq(folders.id, documents.folderId))
					.where(
						and(
							eq(documents.id, documentId),
							isNull(documents.deletedAt),
							...(ctx.source === "external"
								? [
										tenantOwnerCondition(
											documents.ownerId,
											documents.workspaceId,
											ctx,
										),
									]
								: []),
							...(access.restricted
								? [
										access.categoryId
											? effectiveDocumentCategoryCondition(
													documents.categoryId,
													documents.folderId,
													ctx,
													access.categoryId,
												)
											: sql`false`,
									]
								: []),
						),
					)
					.limit(1);
				return row ?? null;
			});
			if (!document) {
				set.status = 404;
				return { error: "Document not found" };
			}
			if (ctx.role !== "none") {
				if (
					!canAccessContent(access, "read") ||
					(ctx.source !== "external" && document.ownerId !== ctx.userId)
				) {
					set.status = 403;
					return { error: "Forbidden" };
				}
			} else {
				const scope = shareToken
					? await resolveShareDocumentScope(lookupCtx, shareToken)
					: null;
				if (!scope?.documentIds.includes(documentId)) {
					set.status = 401;
					return { error: "Authentication required" };
				}
				if (
					!(await verifyShareScopePassword(
						scope,
						request.headers.get("x-share-password"),
					))
				) {
					set.status = 401;
					return { error: "Authentication required" };
				}
			}
			if (!documentReferencesRemoteImage(document, source)) {
				set.status = 403;
				return { error: "Image URL is not referenced by this document" };
			}

			const image = await fetchRemoteImage(source);
			return new Response(Buffer.from(image.bytes), {
				headers: {
					"Content-Type": image.contentType,
					"Cache-Control": "private, max-age=300",
					"X-Content-Type-Options": "nosniff",
				},
			});
		} catch (err) {
			logger.warn({ err }, "Remote DOCX image fetch rejected");
			set.status = 422;
			return { error: "Remote image could not be fetched safely" };
		}
	});
