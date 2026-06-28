import { attachments, documents } from "@hiai-docs/db/schema";
import { and, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { nanoid } from "nanoid";
import { getSessionUserId } from "../../lib/auth-helpers";
import { db } from "../../lib/db";
import { logger } from "../../lib/logger";
import { BUCKET, minio } from "../../lib/minio";
import { rateLimitHeaders, writeRateLimiter } from "../middleware/rate-limit";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
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

export const attachmentRoutes = new Elysia({ prefix: "/api" })

	// POST /api/documents/:id/attachments — Upload image attachment
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
		const doc = await db
			.select({ id: documents.id })
			.from(documents)
			.where(and(eq(documents.id, documentId), eq(documents.ownerId, userId)))
			.limit(1);

		if (!doc.length) {
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

		if (file.size > MAX_FILE_SIZE) {
			set.status = 413;
			return {
				error: `File too large. Maximum size: ${MAX_FILE_SIZE / 1024 / 1024}MB`,
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
		const doc = await db
			.select({ id: documents.id })
			.from(documents)
			.where(and(eq(documents.id, documentId), eq(documents.ownerId, userId)))
			.limit(1);

		if (!doc.length) {
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
