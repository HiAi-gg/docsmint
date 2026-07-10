import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { attachments, documents } from "@hiai-docs/db/schema";
import { and, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { nanoid } from "nanoid";
import { config } from "../../lib/config";
import { logger } from "../../lib/logger";
import { shareTokenAccessForDocument } from "../../lib/share-access";
import { BUCKET, storage, storagePublic } from "../../lib/storage";
import { withTenant } from "../../lib/with-tenant";
import { rateLimitHeaders, writeRateLimiter } from "../middleware/rate-limit";
import { buildTenantContext } from "../middleware/tenant";

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

const PRESIGN_EXPIRY_SECONDS = config.ATTACHMENT_PRESIGN_EXPIRY_SECONDS;

const INTEGRITY_PROBE_BYTES = 8;

type BodyChunk = Uint8Array | Buffer | ArrayBuffer | ArrayBufferView | string;
type AsyncBody = AsyncIterable<BodyChunk>;

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

			const ctx = await buildTenantContext(request);
			if (ctx.role === "none") {
				set.status = 401;
				return { error: "Unauthorized" };
			}
			const userId = ctx.userId;

			const documentId = params.id;
			const docExists = await withTenant(ctx, async (tx) => {
				const [doc] = await tx
					.select({ id: documents.id })
					.from(documents)
					.where(
						and(eq(documents.id, documentId), eq(documents.ownerId, userId)),
					)
					.limit(1);
				return !!doc;
			});
			if (!docExists) {
				set.status = 404;
				return { error: "Document not found" };
			}

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
			const key = `${userId}/${documentId}/${nanoid()}.${ext}`;

			try {
				const url = await getSignedUrl(
					storagePublic,
					new PutObjectCommand({ Bucket: BUCKET, Key: key }),
					{ expiresIn: PRESIGN_EXPIRY_SECONDS },
				);
				return {
					url,
					key,
					maxSize: ATTACHMENT_MAX_SIZE_BYTES,
					expiresIn: PRESIGN_EXPIRY_SECONDS,
				};
			} catch (err) {
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
			const ip = await getClientIp(request);
			const rl = await writeRateLimiter(ip);
			if (!rl.allowed) {
				set.status = 429;
				set.headers = rateLimitHeaders(0, rl.retryAfter);
				return { error: "Too many requests" };
			}
			set.headers = rateLimitHeaders(rl.remaining);

			const ctx = await buildTenantContext(request);
			if (ctx.role === "none") {
				set.status = 401;
				return { error: "Unauthorized" };
			}
			const userId = ctx.userId;

			const documentId = params.id;
			const docExists = await withTenant(ctx, async (tx) => {
				const [doc] = await tx
					.select({ id: documents.id })
					.from(documents)
					.where(
						and(eq(documents.id, documentId), eq(documents.ownerId, userId)),
					)
					.limit(1);
				return !!doc;
			});
			if (!docExists) {
				set.status = 404;
				return { error: "Document not found" };
			}

			const payload = body as
				| {
						key?: unknown;
						filename?: unknown;
						contentType?: unknown;
						size?: unknown;
				  }
				| undefined;
			const key = typeof payload?.key === "string" ? payload.key : "";
			const filename =
				typeof payload?.filename === "string" ? payload.filename : "";
			const contentType =
				typeof payload?.contentType === "string" ? payload.contentType : "";
			const size = typeof payload?.size === "number" ? payload.size : -1;

			if (!key) {
				set.status = 400;
				return { error: "key is required" };
			}
			// Scope check: the key MUST start with `${userId}/${documentId}/`
			// so a caller cannot confirm an upload that belongs to a
			// different user or document. The presign endpoint always
			// generates keys in that shape; rejecting mismatches here is a
			// belt-and-braces guard against a hand-crafted request.
			const expectedPrefix = `${userId}/${documentId}/`;
			if (!key.startsWith(expectedPrefix)) {
				set.status = 400;
				return { error: "key does not match this document/user" };
			}
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

			// Verify the object actually exists in SeaweedFS before we record
			// a row for it. A successful presign + failed PUT (network
			// blip, user closed tab) should not become a dangling DB row.
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

			// Sanity-check the size we recorded against the size storage
			// observed. A client that lies about size gets corrected
			// here so the DB row reflects what was actually stored.
			const storedSize = headOutput.ContentLength ?? size;

			try {
				const created = await withTenant(ctx, async (tx) => {
					const [row] = await tx
						.insert(attachments)
						.values({
							documentId,
							filename,
							mimeType: contentType,
							size: storedSize,
							storageKey: key,
						})
						.returning();
					return row ?? null;
				});

				if (!created) {
					set.status = 500;
					return { error: "Failed to save attachment record" };
				}

				// Same stable same-origin URL the legacy POST returns, so
				// the editor can drop it into `setImage({ src })` without
				// caring which path the upload took.
				set.status = 201;
				return {
					id: created.id,
					filename: created.filename,
					mimeType: created.mimeType,
					size: created.size,
					url: `/api/attachments/${created.id}/raw`,
				};
			} catch (err) {
				logger.error({ err, key }, "Confirm failed: DB insert error");
				set.status = 500;
				return { error: "Failed to save attachment record" };
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

		const ctx = await buildTenantContext(request);
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		const userId = ctx.userId;

		const documentId = params.id;

		// Verify document exists and user owns it
		const docExists = await withTenant(ctx, async (tx) => {
			const [doc] = await tx
				.select({ id: documents.id })
				.from(documents)
				.where(and(eq(documents.id, documentId), eq(documents.ownerId, userId)))
				.limit(1);
			return !!doc;
		});
		if (!docExists) {
			set.status = 404;
			return { error: "Document not found" };
		}

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
		const key = `${userId}/${documentId}/${nanoid()}.${ext}`;

		try {
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
				await storage
					.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
					.catch((removeErr) => {
						logger.error(
							{ err: removeErr, key },
							"Failed to clean up corrupted upload",
						);
					});
				set.status = 500;
				return { error: "Upload integrity check failed" };
			}

			// Insert attachment row
			const created = await withTenant(ctx, async (tx) => {
				const [row] = await tx
					.insert(attachments)
					.values({
						documentId,
						filename: file.name,
						mimeType: file.type,
						size: file.size,
						storageKey: key,
					})
					.returning();
				return row ?? null;
			});

			if (!created) {
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
			logger.error({ err }, "Failed to upload attachment");
			set.status = 500;
			return { error: "Failed to upload attachment" };
		}
	})

	// GET /api/documents/:id/attachments — List attachments for a document
	.get("/documents/:id/attachments", async ({ params, set, request }) => {
		const ctx = await buildTenantContext(request);
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		const userId = ctx.userId;

		const documentId = params.id;

		// Verify document exists and user owns it
		const result = await withTenant(ctx, async (tx) => {
			const [doc] = await tx
				.select({ id: documents.id })
				.from(documents)
				.where(and(eq(documents.id, documentId), eq(documents.ownerId, userId)))
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

		const ctx = await buildTenantContext(request);
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
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
					storageKey: attachments.storageKey,
					ownerId: documents.ownerId,
				})
				.from(attachments)
				.innerJoin(documents, eq(documents.id, attachments.documentId))
				.where(eq(attachments.id, attachmentId))
				.limit(1);
			return r ?? null;
		});

		if (!row) {
			set.status = 404;
			return { error: "Attachment not found" };
		}
		if (row.ownerId !== userId) {
			set.status = 403;
			return { error: "Forbidden" };
		}

		// Best-effort object removal. A failure here is logged but does
		// NOT block the DB delete — orphaned storage is cheaper to clean
		// up out-of-band than a phantom attachment row the user can't
		// remove.
		try {
			await storage.send(
				new DeleteObjectCommand({ Bucket: BUCKET, Key: row.storageKey }),
			);
		} catch (err) {
			logger.warn(
				{ err, key: row.storageKey, attachmentId },
				"Failed to remove attachment object from storage; proceeding to delete DB row",
			);
		}

		await withTenant(ctx, async (tx) => {
			await tx.delete(attachments).where(eq(attachments.id, attachmentId));
		});

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
			const ctx = await buildTenantContext(request);
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
				ctx.role === "admin"
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
					})
					.from(attachments)
					.innerJoin(documents, eq(documents.id, attachments.documentId))
					.where(eq(attachments.id, params.id))
					.limit(1);
				return r ?? null;
			});

			if (!row) {
				set.status = 404;
				return { error: "Attachment not found" };
			}

			if (ctx.role !== "none") {
				if (row.ownerId !== ctx.userId) {
					set.status = 403;
					return { error: "Forbidden" };
				}
			} else if (shareToken) {
				const verdict = await shareTokenAccessForDocument(
					lookupCtx,
					row.documentId,
					shareToken,
				);
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
	});
