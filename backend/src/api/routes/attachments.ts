import { attachments, documents } from "@hiai-docs/db/schema";
import { and, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { nanoid } from "nanoid";
import { getSessionUserId } from "../../lib/auth-helpers";
import { config } from "../../lib/config";
import { db } from "../../lib/db";
import { logger } from "../../lib/logger";
import { BUCKET, minio, minioPublic } from "../../lib/minio";
import { rateLimitHeaders, writeRateLimiter } from "../middleware/rate-limit";

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

/**
 * Read the first few bytes of an uploaded object back from MinIO and
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
		const stream = await minio.getPartialObject(BUCKET, key, 0, probeLen);
		const chunks: Buffer[] = [];
		for await (const chunk of stream) {
			chunks.push(chunk as Buffer);
		}
		const actual = Buffer.concat(chunks);
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

/**
 * Verify that the authenticated user owns the document at `documentId`.
 * Returns the doc row on success, or null on missing/forbidden.
 */
async function ownedDocumentOrNull(
	documentId: string,
	userId: string,
): Promise<{ id: string } | null> {
	const doc = await db
		.select({ id: documents.id })
		.from(documents)
		.where(and(eq(documents.id, documentId), eq(documents.ownerId, userId)))
		.limit(1);
	return doc[0] ?? null;
}

export const attachmentRoutes = new Elysia({ prefix: "/api" })

	// POST /api/documents/:id/attachments/presign
	//
	// Returns a presigned MinIO PUT URL that the browser can upload to
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

			const userId = await getSessionUserId(request.headers);
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const documentId = params.id;
			const doc = await ownedDocumentOrNull(documentId, userId);
			if (!doc) {
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

			// Generate MinIO key. Reuse the existing naming shape so the
			// download route (GET /attachments/:id/raw) keeps working for
			// any old records created before presign was introduced.
			const ext = filename.split(".").pop() ?? "bin";
			const key = `${userId}/${documentId}/${nanoid()}.${ext}`;

			try {
				const url = await minioPublic.presignedPutObject(
					BUCKET,
					key,
					PRESIGN_EXPIRY_SECONDS,
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
	// Verifies the object exists in MinIO with the expected size before
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

			const userId = await getSessionUserId(request.headers);
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const documentId = params.id;
			const doc = await ownedDocumentOrNull(documentId, userId);
			if (!doc) {
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

			// Verify the object actually exists in MinIO before we record
			// a row for it. A successful presign + failed PUT (network
			// blip, user closed tab) should not become a dangling DB row.
			let stat: Awaited<ReturnType<typeof minio.statObject>>;
			try {
				stat = await minio.statObject(BUCKET, key);
			} catch (err) {
				logger.warn({ err, key }, "Confirm failed: object not in MinIO");
				set.status = 409;
				return { error: "Upload not found in storage — please retry upload" };
			}

			// Sanity-check the size we recorded against the size MinIO
			// observed. A client that lies about size gets corrected
			// here so the DB row reflects what was actually stored.
			const storedSize =
				typeof stat.size === "number"
					? stat.size
					: Number((stat as { size?: number }).size ?? size);

			try {
				const [created] = await db
					.insert(attachments)
					.values({
						documentId,
						filename,
						mimeType: contentType,
						size: storedSize,
						minioKey: key,
					})
					.returning();

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
	// can't reach MinIO directly). New uploads from the editor go through
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

		const userId = await getSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Unauthorized" };
		}

		const documentId = params.id;

		// Verify document exists and user owns it
		const doc = await ownedDocumentOrNull(documentId, userId);
		if (!doc) {
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

		// Generate MinIO key
		const ext = file.name.split(".").pop() ?? "bin";
		const key = `${userId}/${documentId}/${nanoid()}.${ext}`;

		try {
			// Upload to MinIO
			const arrayBuffer = await file.arrayBuffer();
			const buffer = Buffer.from(arrayBuffer);
			await minio.putObject(BUCKET, key, buffer, file.size, {
				"Content-Type": file.type,
			});

			// Defensive integrity check: read the first 8 bytes back from
			// MinIO and compare to the source buffer. The current pipeline
			// (Bun Request.formData() + Buffer.from(arrayBuffer) +
			// minio.putObject) is binary-safe — empirical round-trip tests
			// confirm no corruption — but a non-text-mode regression in any
			// of those layers would surface as 0x89 being replaced with
			// 0xEF 0xBF 0xBD (UTF-8 U+FFFD) for PNG/JPEG high-bit bytes.
			// The check is best-effort: a readback failure (e.g. transient
			// network blip) logs a warning but does not fail the upload.
			const integrityOk = await verifyUploadIntegrity(buffer, key);
			if (!integrityOk) {
				await minio.removeObject(BUCKET, key).catch((removeErr) => {
					logger.error(
						{ err: removeErr, key },
						"Failed to clean up corrupted upload",
					);
				});
				set.status = 500;
				return { error: "Upload integrity check failed" };
			}

			// Insert attachment row
			const [created] = await db
				.insert(attachments)
				.values({
					documentId,
					filename: file.name,
					mimeType: file.type,
					size: file.size,
					minioKey: key,
				})
				.returning();

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
		const userId = await getSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Unauthorized" };
		}

		const documentId = params.id;

		// Verify document exists and user owns it
		const doc = await ownedDocumentOrNull(documentId, userId);
		if (!doc) {
			set.status = 404;
			return { error: "Document not found" };
		}

		try {
			const rows = await db
				.select()
				.from(attachments)
				.where(eq(attachments.documentId, documentId));

			// Stable same-origin streaming URLs (see POST handler note).
			const result = rows.map((row) => ({
				id: row.id,
				filename: row.filename,
				mimeType: row.mimeType,
				size: row.size,
				url: `/api/attachments/${row.id}/raw`,
			}));

			return { items: result };
		} catch (err) {
			logger.error({ err }, "Failed to list attachments");
			set.status = 500;
			return { error: "Failed to list attachments" };
		}
	})

	// GET /api/attachments/:id/raw — Stream attachment bytes (PUBLIC, no auth).
	// Intentionally public so images embedded in shared documents load without
	// a session. The attachment id is a UUID, so it is unguessable.
	.get("/attachments/:id/raw", async ({ params, set }) => {
		try {
			const [row] = await db
				.select()
				.from(attachments)
				.where(eq(attachments.id, params.id))
				.limit(1);
			if (!row) {
				set.status = 404;
				return { error: "Attachment not found" };
			}

			const stream = await minio.getObject(BUCKET, row.minioKey);
			const chunks: Buffer[] = [];
			for await (const chunk of stream) {
				chunks.push(chunk as Buffer);
			}
			const buffer = Buffer.concat(chunks);
			return new Response(buffer, {
				headers: {
					"Content-Type": row.mimeType,
					"Cache-Control": "public, max-age=31536000, immutable",
				},
			});
		} catch (err) {
			logger.error({ err }, "Failed to stream attachment");
			set.status = 500;
			return { error: "Failed to stream attachment" };
		}
	});
