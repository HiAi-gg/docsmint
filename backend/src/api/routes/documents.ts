import { CopyObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import {
	attachments,
	documentPipelineRuns,
	documents,
	documentTags,
	folders,
	tags,
	versions,
} from "@hiai-docs/db/schema";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";
import { recordAuditEvent } from "../../lib/audit";
import {
	canAccessContent,
	isAuthorizedCategory,
	resolveContentAccess,
	resolveFolderEffectiveCategory,
} from "../../lib/content-access";
import { contentHash } from "../../lib/content-hash";
import {
	cacheGetOrSet,
	docListKey,
	docSingleKey,
	invalidateDocCache,
	invalidateDocListCache,
} from "../../lib/doc-cache";
import { DocxParseError, docxToMarkdown } from "../../lib/docx-parser";
import {
	encodeS3CopySource,
	planDuplicateAttachments,
	rewriteDuplicateAttachmentReferences,
} from "../../lib/duplicate-attachments";
import { logger } from "../../lib/logger";
import { enqueueReembed } from "../../lib/reembed";
import { BUCKET, storage } from "../../lib/storage";
import { maybePruneVersions } from "../../lib/version-prune";
import { withTenant } from "../../lib/with-tenant";
import { enqueueDocumentPipeline } from "../../queue/enqueue";
import {
	documentRateLimiter,
	rateLimitHeaders,
	writeRateLimiter,
} from "../middleware/rate-limit";

const createDocumentSchema = z.object({
	title: z.string().min(1).max(500).default("Untitled"),
	content: z.string().optional(),
	folderId: z.string().uuid().optional(),
	categoryId: z.string().uuid().nullable().optional(),
	visibility: z.enum(["private", "shared", "public"]).optional(),
});

const updateDocumentSchema = z.object({
	title: z.string().min(1).max(500).optional(),
	content: z.string().optional(),
	contentJson: z.unknown().optional(),
	metadata: z.unknown().optional(),
	folderId: z.string().uuid().nullable().optional(),
	categoryId: z.string().uuid().nullable().optional(),
	visibility: z.enum(["private", "shared", "public"]).optional(),
});

const listQuerySchema = z.object({
	folderId: z.string().uuid().optional(),
	tag: z.string().uuid().optional(),
	page: z.coerce.number().int().min(1).default(1),
	limit: z.coerce.number().int().min(1).max(1000).default(20),
});

const ALLOWED_IMPORT_EXTENSIONS = [
	".md",
	".txt",
	".markdown",
	".json",
	".docx",
];
const MAX_IMPORT_SIZE = 10 * 1024 * 1024;
const MAX_IMPORT_FILES = 10;
const MAX_IMPORT_REQUEST_SIZE = 50 * 1024 * 1024;
const MAX_EXTRACTED_CONTENT_SIZE = 25 * 1024 * 1024;

class ImportInputError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 413 | 422,
	) {
		super(message);
		this.name = "ImportInputError";
	}
}

function assertImportContentSize(content: string, filename: string): void {
	const size = Buffer.byteLength(content, "utf8");
	if (size > MAX_EXTRACTED_CONTENT_SIZE) {
		throw new ImportInputError(
			`Extracted content from "${filename}" is too large. Maximum size: ${MAX_EXTRACTED_CONTENT_SIZE / 1024 / 1024}MB`,
			413,
		);
	}
}

const ALLOWED_IMPORT_ERROR_CODES = new Set([
	"22001",
	"23503",
	"23505",
	"42501",
	"54000",
]);

function importErrorTelemetry(err: unknown): {
	kind: "database" | "syntax" | "unknown";
	code?: string;
} {
	const candidate =
		err instanceof Error && err.cause instanceof Error ? err.cause : err;
	const rawCode =
		candidate instanceof Error &&
		"code" in candidate &&
		typeof candidate.code === "string"
			? candidate.code
			: undefined;
	const code =
		rawCode && ALLOWED_IMPORT_ERROR_CODES.has(rawCode) ? rawCode : undefined;
	if (code) return { kind: "database", code };
	if (candidate instanceof SyntaxError) return { kind: "syntax" };
	return { kind: "unknown" };
}

function byteSizeBucket(bytes: number): string {
	if (bytes < 1024 * 1024) return "lt_1mb";
	if (bytes < 5 * 1024 * 1024) return "1_to_5mb";
	if (bytes < 10 * 1024 * 1024) return "5_to_10mb";
	if (bytes < 25 * 1024 * 1024) return "10_to_25mb";
	return "gte_25mb";
}

const importJsonSchema = z.object({
	title: z.string().min(1).max(500).optional(),
	content: z.string().min(1).max(5_000_000),
	folderId: z.string().uuid().optional(),
});

/**
 * Resolve a single uploaded file to an importable item ({title, content}).
 *
 * Branching:
 *   - .json: parse as JSON, validate against `importJsonSchema`, use embedded
 *     title/content when present.
 *   - .docx: stream into a Buffer and convert via `docxToMarkdown`. The
 *     filename minus `.docx` becomes the title. mammoth's plain-text output
 *     is sufficient for chunking/embedding and avoids extra dependency on
 *     the `mammoth/mammoth.markdown` subpath.
 *   - .md / .markdown / .txt: read as text, derive title from filename.
 *
 * Errors thrown here bubble up to the `/import` handler which decides the
 * appropriate HTTP status (422 for DOCX parse failures, 400 for JSON shape
 * problems, 500 for the rest).
 */
async function importFileToItem(file: File): Promise<{
	title: string;
	content: string;
}> {
	const name = file.name;
	if (name.toLowerCase().endsWith(".docx")) {
		const arrayBuffer = await file.arrayBuffer();
		const buffer = Buffer.from(arrayBuffer);
		const content = await docxToMarkdown(buffer, name);
		assertImportContentSize(content, name);
		return {
			title: name.replace(/\.docx$/i, ""),
			content,
		};
	}
	if (name.toLowerCase().endsWith(".json")) {
		const text = await file.text();
		let jsonBody: unknown;
		try {
			jsonBody = JSON.parse(text);
		} catch {
			throw new ImportInputError("Invalid JSON syntax in uploaded file", 400);
		}
		const jsonParsed = importJsonSchema.safeParse(jsonBody);
		if (!jsonParsed.success) {
			throw new ImportInputError(
				"Uploaded JSON does not match the document import schema",
				422,
			);
		}
		assertImportContentSize(jsonParsed.data.content, name);
		return {
			title: jsonParsed.data.title ?? name.replace(/\.json$/i, ""),
			content: jsonParsed.data.content,
		};
	}
	const text = await file.text();
	assertImportContentSize(text, name);
	return {
		title: name.replace(/\.(md|txt|markdown)$/i, ""),
		content: text,
	};
}

/**
 * Attach a `tags` array (`{ id, name, color }`) to each document row in a
 * list response. Runs a single grouped query for all rows so the list
 * endpoint can show tags without an N+1 round trip.
 */
async function withTags<T extends { id: string }>(
	ctx: import("../../api/middleware/tenant").TenantContext,
	rows: T[],
): Promise<
	Array<T & { tags: Array<{ id: string; name: string; color: string | null }> }>
> {
	if (rows.length === 0) return [];
	const ids = rows.map((r) => r.id);
	const tagRows = await withTenant(ctx, async (tx) => {
		return tx
			.select({
				documentId: documentTags.documentId,
				id: tags.id,
				name: tags.name,
				color: tags.color,
			})
			.from(documentTags)
			.innerJoin(tags, eq(tags.id, documentTags.tagId))
			.where(inArray(documentTags.documentId, ids));
	});

	const byDoc = new Map<
		string,
		Array<{ id: string; name: string; color: string | null }>
	>();
	for (const t of tagRows) {
		const list = byDoc.get(t.documentId) ?? [];
		list.push({ id: t.id, name: t.name, color: t.color });
		byDoc.set(t.documentId, list);
	}
	return rows.map((r) => ({ ...r, tags: byDoc.get(r.id) ?? [] }));
}

async function resolveFolderCategory(
	ctx: import("../../api/middleware/tenant").TenantContext,
	folderId: string,
): Promise<string | null> {
	const rows = await withTenant(ctx, async (tx) => {
		return tx.execute(sql`
			WITH RECURSIVE ancestors AS (
				SELECT id, parent_id, category_id
				FROM folders
				WHERE id = ${folderId} AND owner_id = ${ctx.userId}
				UNION ALL
				SELECT f.id, f.parent_id, f.category_id
				FROM folders f
				JOIN ancestors a ON f.id = a.parent_id
				WHERE f.owner_id = ${ctx.userId}
			)
			SELECT category_id FROM ancestors
			WHERE category_id IS NOT NULL
			LIMIT 1
		`);
	});
	const row = rows[0] as { category_id: string } | undefined;
	return row?.category_id ?? null;
}

export const documentRoutes = new Elysia({ prefix: "/api" })
	// GET /api/documents — List documents with pagination
	.get("/documents", async ({ query, set, request }) => {
		const ip =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"unknown";
		const rl = await documentRateLimiter(ip, request);
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
		if (!canAccessContent(access, "read")) {
			set.status = 403;
			return { error: "Forbidden" };
		}
		const userId = ctx.userId;
		const parsed = listQuerySchema.safeParse(query);
		if (!parsed.success) {
			set.status = 400;
			return { error: "Invalid query", details: parsed.error.flatten() };
		}
		const { folderId, tag, page, limit } = parsed.data;
		const offset = (page - 1) * limit;
		const cacheKey = `${docListKey(userId, folderId, tag, page, limit)}:scope:${access.categoryId ?? "all"}`;
		try {
			return await cacheGetOrSet(cacheKey, 30, async () => {
				const conditions = [eq(documents.ownerId, userId)];
				if (access.restricted && access.categoryId) {
					conditions.push(eq(documents.categoryId, access.categoryId));
				}
				if (folderId) conditions.push(eq(documents.folderId, folderId));

				if (tag) {
					const [countResult, rows] = await withTenant(ctx, async (tx) => {
						return Promise.all([
							tx
								.select({ total: count() })
								.from(documents)
								.innerJoin(
									documentTags,
									eq(documents.id, documentTags.documentId),
								)
								.where(and(eq(documentTags.tagId, tag), ...conditions)),
							tx
								.select({
									id: documents.id,
									title: documents.title,
									content: sql<string>`LEFT(${documents.content}, 200)`.as(
										"content",
									),
									folderId: documents.folderId,
									categoryId: documents.categoryId,
									visibility: documents.visibility,
									createdAt: documents.createdAt,
									updatedAt: documents.updatedAt,
								})
								.from(documents)
								.innerJoin(
									documentTags,
									eq(documents.id, documentTags.documentId),
								)
								.where(and(eq(documentTags.tagId, tag), ...conditions))
								.orderBy(desc(documents.updatedAt))
								.limit(limit)
								.offset(offset),
						]);
					});
					return {
						items: await withTags(ctx, rows),
						total: countResult[0]?.total ?? 0,
						page,
						limit,
					};
				}

				const [countResult, rows] = await withTenant(ctx, async (tx) => {
					return Promise.all([
						tx
							.select({ total: count() })
							.from(documents)
							.where(and(...conditions)),
						tx
							.select({
								id: documents.id,
								title: documents.title,
								content: sql<string>`LEFT(${documents.content}, 200)`.as(
									"content",
								),
								folderId: documents.folderId,
								categoryId: documents.categoryId,
								visibility: documents.visibility,
								createdAt: documents.createdAt,
								updatedAt: documents.updatedAt,
							})
							.from(documents)
							.where(and(...conditions))
							.orderBy(desc(documents.updatedAt))
							.limit(limit)
							.offset(offset),
					]);
				});
				return {
					items: await withTags(ctx, rows),
					total: countResult[0]?.total ?? 0,
					page,
					limit,
				};
			});
		} catch (err) {
			logger.error({ err }, "Failed to list documents");
			set.status = 500;
			return { error: "Failed to list documents" };
		}
	})

	// POST /api/documents — Create document + initial version
	.post("/documents", async ({ request, set }) => {
		const ip =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"unknown";
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
		if (!canAccessContent(access, "write")) {
			set.status = 403;
			return { error: "Forbidden" };
		}
		const userId = ctx.userId;
		const body = createDocumentSchema.safeParse(await request.json());
		if (!body.success) {
			set.status = 400;
			return { error: "Invalid input", details: body.error.flatten() };
		}
		try {
			// `contentJson` is the editor's JSON cache of the markdown
			// `content`. It is populated by the client (the editor sends
			// it on every save); the server never generates it. The
			// markdown `content` is the source of truth — see the
			// `initialDocJson = null` initialiser below. Callers that
			// bypass the editor (imports, scripts) intentionally leave
			// `contentJson` null so the frontend's `markdownToJson`
			// helper can rehydrate the JSON view from the authoritative
			// markdown on the next open.
			const initialContent = body.data.content ?? "";
			const initialHash = contentHash(body.data.title, initialContent);
			const initialDocJson = null;
			const folderId = body.data.folderId ?? null;
			let categoryId = body.data.categoryId ?? null;
			if (folderId && !categoryId) {
				categoryId = await resolveFolderCategory(ctx, folderId);
			}
			if (!isAuthorizedCategory(access, categoryId)) {
				set.status = 403;
				return { error: "Forbidden" };
			}

			const created = await withTenant(ctx, async (tx) => {
				const [row] = await tx
					.insert(documents)
					.values({
						ownerId: userId,
						title: body.data.title,
						content: initialContent,
						contentHash: initialHash,
						contentJson: initialDocJson,
						folderId,
						categoryId,
						...(body.data.visibility && { visibility: body.data.visibility }),
					})
					.returning();
				if (!row) {
					throw new Error("Failed to create document");
				}
				await tx.insert(versions).values({
					documentId: row.id,
					content: initialContent,
					contentJson: null,
					createdBy: userId,
				});
				return row;
			});

			void enqueueDocumentPipeline({
				documentId: created.id,
				ownerId: userId,
				revision: contentHash(created.title, created.content ?? ""),
				source: "interactive",
			}).catch((err) =>
				logger.warn({ err, documentId: created.id }, "Pipeline enqueue failed"),
			);
			invalidateDocListCache(userId);
			set.status = 201;

			const ipAddress =
				request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
				request.headers.get("x-real-ip") ??
				"";
			const userAgent = request.headers.get("user-agent") ?? "";
			recordAuditEvent({
				actorId: userId,
				action: "document.create",
				resourceType: "document",
				resourceId: created.id,
				details: { title: created.title },
				ipAddress,
				userAgent,
			}).catch(() => {});

			return created;
		} catch (err) {
			logger.error({ err }, "Failed to create document");
			set.status = 500;
			return { error: "Failed to create document" };
		}
	})

	// GET /api/documents/:id — Get document with tags
	.get("/documents/:id/pipeline", async ({ params, set, request }) => {
		const access = await resolveContentAccess(request);
		const ctx = access.ctx;
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		if (!canAccessContent(access, "read")) {
			set.status = 403;
			return { error: "Forbidden" };
		}
		try {
			const [run] = await withTenant(ctx, (tx) =>
				tx
					.select({
						documentId: documentPipelineRuns.documentId,
						generationId: documentPipelineRuns.generationId,
						revision: documentPipelineRuns.revision,
						status: documentPipelineRuns.status,
						prepareStatus: documentPipelineRuns.prepareStatus,
						embedStatus: documentPipelineRuns.embedStatus,
						graphStatus: documentPipelineRuns.graphStatus,
						summarizeStatus: documentPipelineRuns.summarizeStatus,
						finalizeStatus: documentPipelineRuns.finalizeStatus,
						totalBatches: documentPipelineRuns.totalBatches,
						completedBatches: documentPipelineRuns.completedBatches,
						failedBatches: documentPipelineRuns.failedBatches,
						updatedAt: documentPipelineRuns.updatedAt,
					})
					.from(documentPipelineRuns)
					.innerJoin(
						documents,
						eq(documents.id, documentPipelineRuns.documentId),
					)
					.where(
						and(
							eq(documentPipelineRuns.documentId, params.id),
							eq(documentPipelineRuns.ownerId, ctx.userId),
							...(access.restricted && access.categoryId
								? [eq(documents.categoryId, access.categoryId)]
								: []),
						),
					)
					.orderBy(desc(documentPipelineRuns.updatedAt))
					.limit(1),
			);
			if (!run) {
				set.status = 404;
				return { error: "Pipeline run not found" };
			}
			return {
				documentId: run.documentId,
				generationId: run.generationId,
				status: run.status,
				revision: run.revision,
				stages: {
					prepare: run.prepareStatus,
					embed: run.embedStatus,
					graph: run.graphStatus,
					summarize: run.summarizeStatus,
					finalize: run.finalizeStatus,
				},
				batches: {
					total: run.totalBatches,
					completed: run.completedBatches,
					failed: run.failedBatches,
				},
				updatedAt: run.updatedAt,
			};
		} catch (err) {
			logger.error(
				{ err, documentId: params.id },
				"Failed to load pipeline progress",
			);
			set.status = 500;
			return { error: "Failed to load pipeline progress" };
		}
	})
	.get("/documents/:id", async ({ params, set, request }) => {
		const ip =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"unknown";
		const rl = await documentRateLimiter(ip, request);
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
		if (!canAccessContent(access, "read")) {
			set.status = 403;
			return { error: "Forbidden" };
		}
		const userId = ctx.userId;
		try {
			return await cacheGetOrSet(
				`${docSingleKey(params.id, userId)}:scope:${access.categoryId ?? "all"}`,
				60,
				async () => {
					const result = await withTenant(ctx, async (tx) => {
						const rows = await tx
							.select({
								id: documents.id,
								ownerId: documents.ownerId,
								folderId: documents.folderId,
								folderName: folders.name,
								categoryId: documents.categoryId,
								title: documents.title,
								content: documents.content,
								contentJson: documents.contentJson,
								metadata: documents.metadata,
								visibility: documents.visibility,
								createdAt: documents.createdAt,
								updatedAt: documents.updatedAt,
							})
							.from(documents)
							.leftJoin(folders, eq(folders.id, documents.folderId))
							.where(
								and(
									eq(documents.id, params.id),
									eq(documents.ownerId, userId),
									...(access.restricted && access.categoryId
										? [eq(documents.categoryId, access.categoryId)]
										: []),
								),
							)
							.limit(1);

						const doc = rows[0];
						if (!doc) {
							return null;
						}

						const docTags = await tx
							.select({ id: tags.id, name: tags.name, color: tags.color })
							.from(tags)
							.innerJoin(documentTags, eq(tags.id, documentTags.tagId))
							.where(eq(documentTags.documentId, doc.id));

						return { ...doc, tags: docTags };
					});

					if (!result) {
						set.status = 404;
						return { error: "Document not found" };
					}
					return result;
				},
				{
					// Large imported documents are already stored durably in Postgres.
					// Duplicating multi-megabyte Markdown/editor JSON in Redis makes a
					// single open evict useful cache entries and adds avoidable main-thread
					// JSON serialization pressure to the API process.
					shouldCache: (value) => {
						if (!value || "error" in value) return true;
						const jsonSize = value.contentJson
							? JSON.stringify(value.contentJson).length
							: 0;
						return (value.content?.length ?? 0) + jsonSize <= 512 * 1024;
					},
				},
			);
		} catch (err) {
			logger.error({ err }, "Failed to get document");
			set.status = 500;
			return { error: "Failed to get document" };
		}
	})

	// PATCH /api/documents/:id — Update document, save version before
	.patch("/documents/:id", async ({ params, request, set }) => {
		const ip =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"unknown";
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
		const userId = ctx.userId;
		const body = updateDocumentSchema.safeParse(await request.json());
		if (!body.success) {
			set.status = 400;
			return { error: "Invalid input", details: body.error.flatten() };
		}
		const hasPlacementInput =
			body.data.folderId !== undefined || body.data.categoryId !== undefined;
		const hasEditInput =
			body.data.title !== undefined ||
			body.data.content !== undefined ||
			body.data.contentJson !== undefined ||
			body.data.metadata !== undefined ||
			body.data.visibility !== undefined;
		if (
			(hasEditInput && !canAccessContent(access, "edit")) ||
			(!hasEditInput &&
				!canAccessContent(access, "edit") &&
				!canAccessContent(access, "write"))
		) {
			set.status = 403;
			return { error: "Forbidden" };
		}
		if (
			!body.data.title &&
			body.data.content === undefined &&
			body.data.contentJson === undefined &&
			body.data.metadata === undefined &&
			body.data.folderId === undefined &&
			body.data.categoryId === undefined
		) {
			set.status = 400;
			return { error: "At least one field is required" };
		}
		try {
			const result = await withTenant(ctx, async (tx) => {
				const existingRows = await tx
					.select({
						id: documents.id,
						title: documents.title,
						content: documents.content,
						contentJson: documents.contentJson,
						folderId: documents.folderId,
						categoryId: documents.categoryId,
						contentHash: documents.contentHash,
					})
					.from(documents)
					.where(
						and(eq(documents.id, params.id), eq(documents.ownerId, userId)),
					)
					.limit(1);
				if (existingRows.length === 0) {
					return null;
				}
				const existing = existingRows[0];
				if (!existing || !isAuthorizedCategory(access, existing.categoryId)) {
					return { forbidden: true as const };
				}
				if (hasPlacementInput) {
					let destinationCategory: string | null | undefined =
						body.data.categoryId !== undefined
							? body.data.categoryId
							: existing.categoryId;
					if (body.data.folderId) {
						destinationCategory = await resolveFolderEffectiveCategory(
							tx,
							userId,
							body.data.folderId,
						);
					}
					if (!isAuthorizedCategory(access, destinationCategory ?? null)) {
						return { forbidden: true as const };
					}
					const placementChanged =
						(body.data.folderId !== undefined &&
							body.data.folderId !== existing.folderId) ||
						(body.data.categoryId !== undefined &&
							body.data.categoryId !== existing.categoryId);
					if (placementChanged && !canAccessContent(access, "write")) {
						return { forbidden: true as const };
					}
				}

				await tx.insert(versions).values({
					documentId: params.id,
					content: existing?.content ?? "",
					contentJson: existing?.contentJson,
					createdBy: userId,
				});

				// `contentJson` is the editor's JSON cache of the markdown
				// `content`. It is populated by the client (the editor sends
				// it on every save); the server never generates it. When the
				// client supplies only `content` (e.g. an import, a script,
				// the markdown-toggle path that bypasses the editor), the
				// JSON is left null — the frontend's `markdownToJson`
				// helper rehydrates it from the authoritative markdown on
				// the next open. The markdown `content` is the source of
				// truth.
				const resolvedDocJson: unknown | undefined = body.data.contentJson;

				const [updated] = await tx
					.update(documents)
					.set({
						...(body.data.title !== undefined && { title: body.data.title }),
						...(body.data.content !== undefined && {
							content: body.data.content,
						}),
						...(resolvedDocJson !== undefined && {
							contentJson: resolvedDocJson,
						}),
						...(body.data.metadata !== undefined && {
							metadata: body.data.metadata,
						}),
						...(body.data.folderId !== undefined && {
							folderId: body.data.folderId,
						}),
						...(body.data.categoryId !== undefined && {
							categoryId: body.data.categoryId,
						}),
						...(body.data.visibility !== undefined && {
							visibility: body.data.visibility,
						}),
						updatedAt: new Date(),
					})
					.where(
						and(eq(documents.id, params.id), eq(documents.ownerId, userId)),
					)
					.returning();

				return { updated, existing };
			});

			if (!result) {
				set.status = 404;
				return { error: "Document not found" };
			}
			if ("forbidden" in result) {
				set.status = 403;
				return { error: "Forbidden" };
			}
			const { updated, existing } = result;

			// Fire-and-forget pruning. We don't await — pruning is a
			// background GC pass and must not block the user's PATCH
			// response. `maybePruneVersions` debounces itself via Redis
			// so rapid PATCHes (auto-save) won't trigger repeated scans.
			maybePruneVersions(params.id).catch((err: unknown) =>
				logger.error({ err, docId: params.id }, "Background prune failed"),
			);

			// Re-embed if either the content changed OR any metadata-bearing
			// field changed. The embedding preamble includes folder/category
			// names, so changing either invalidates the existing vectors even
			// when the content text is unchanged.
			const folderChanged =
				body.data.folderId !== undefined &&
				body.data.folderId !== existing?.folderId;
			const categoryChanged =
				body.data.categoryId !== undefined &&
				body.data.categoryId !== existing?.categoryId;

			let shouldReembed = folderChanged || categoryChanged;

			if (
				!shouldReembed &&
				(body.data.content !== undefined || body.data.title !== undefined)
			) {
				// Only re-embed if content actually changed (not an auto-save of same content)
				const titleToHash = body.data.title ?? existing?.title ?? "";
				const contentToHash = body.data.content ?? existing?.content ?? "";
				const newHash = contentHash(titleToHash, contentToHash);

				if (existing?.contentHash !== newHash) {
					shouldReembed = true;
				}
			}

			if (shouldReembed) {
				// Use enqueueReembed for Redis SET-NX dedup so rapid PATCHes on the same doc
				// (auto-save) coalesce into a single worker tick. Direct enqueueEmbedding
				// would queue the same doc id once per PATCH.
				enqueueReembed([params.id]);
			}
			// Preserve read-after-write consistency for placement changes. A
			// fire-and-forget invalidation allowed the sidebar's immediate list
			// request to repopulate itself from the stale Redis entry, making a
			// successful move appear only after a later cache expiry/refresh.
			await Promise.all([
				invalidateDocCache(params.id),
				invalidateDocListCache(userId),
			]);

			const ipAddress =
				request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
				request.headers.get("x-real-ip") ??
				"";
			const userAgent = request.headers.get("user-agent") ?? "";
			recordAuditEvent({
				actorId: userId,
				action: "document.update",
				resourceType: "document",
				resourceId: params.id,
				details: { title: updated?.title },
				ipAddress,
				userAgent,
			}).catch(() => {});

			return updated;
		} catch (err) {
			logger.error({ err }, "Failed to update document");
			set.status = 500;
			return { error: "Failed to update document" };
		}
	})

	// POST /api/documents/:id/duplicate — Duplicate document with "(Copy)" suffix
	.post("/documents/:id/duplicate", async ({ params, request, set }) => {
		const ip =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"unknown";
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
		if (!canAccessContent(access, "write")) {
			set.status = 403;
			return { error: "Forbidden" };
		}
		const userId = ctx.userId;
		const copiedStorageKeys: string[] = [];
		try {
			const sourceBundle = await withTenant(ctx, async (tx) => {
				const sourceRows = await tx
					.select()
					.from(documents)
					.where(
						and(
							eq(documents.id, params.id),
							eq(documents.ownerId, userId),
							...(access.restricted && access.categoryId
								? [eq(documents.categoryId, access.categoryId)]
								: []),
						),
					)
					.limit(1);
				const source = sourceRows[0];
				if (!source) {
					return null;
				}
				const sourceAttachments = await tx
					.select()
					.from(attachments)
					.where(eq(attachments.documentId, source.id));
				return { source, sourceAttachments };
			});
			if (!sourceBundle) {
				set.status = 404;
				return { error: "Document not found" };
			}

			const copyId = crypto.randomUUID();
			const attachmentPlans = planDuplicateAttachments(
				sourceBundle.sourceAttachments,
				userId,
				copyId,
			);
			for (const plan of attachmentPlans) {
				await storage.send(
					new CopyObjectCommand({
						Bucket: BUCKET,
						CopySource: encodeS3CopySource(BUCKET, plan.sourceStorageKey),
						Key: plan.storageKey,
					}),
				);
				copiedStorageKeys.push(plan.storageKey);
			}

			const source = sourceBundle.source;
			const rewrittenContent = rewriteDuplicateAttachmentReferences(
				source.content ?? "",
				attachmentPlans,
			);
			const rewrittenContentJson = rewriteDuplicateAttachmentReferences(
				source.contentJson,
				attachmentPlans,
			);
			const copyTitle = `${source.title} (Copy)`;
			const copyHash = contentHash(copyTitle, rewrittenContent);
			const copy = await withTenant(ctx, async (tx) => {
				const [row] = await tx
					.insert(documents)
					.values({
						id: copyId,
						ownerId: userId,
						folderId: source.folderId,
						categoryId: source.categoryId,
						title: copyTitle,
						content: rewrittenContent,
						contentHash: copyHash,
						contentJson: rewrittenContentJson,
						metadata: source.metadata,
					})
					.returning();
				if (!row) {
					throw new Error("Failed to duplicate document");
				}
				if (attachmentPlans.length > 0) {
					await tx.insert(attachments).values(
						attachmentPlans.map((plan) => ({
							id: plan.id,
							documentId: row.id,
							filename: plan.filename,
							mimeType: plan.mimeType,
							size: plan.size,
							storageKey: plan.storageKey,
						})),
					);
				}

				await tx.insert(versions).values({
					documentId: row.id,
					content: rewrittenContent,
					contentJson: rewrittenContentJson,
					createdBy: userId,
				});

				return row;
			});

			void enqueueDocumentPipeline({
				documentId: copy.id,
				ownerId: userId,
				revision: contentHash(copy.title, copy.content ?? ""),
				source: "interactive",
			}).catch((err) =>
				logger.warn({ err, documentId: copy.id }, "Pipeline enqueue failed"),
			);
			invalidateDocListCache(userId);
			set.status = 201;
			return copy;
		} catch (err) {
			await Promise.allSettled(
				copiedStorageKeys.map((key) =>
					storage.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })),
				),
			);
			logger.error({ err }, "Failed to duplicate document");
			set.status = 500;
			return { error: "Failed to duplicate document" };
		}
	})

	// DELETE /api/documents/:id — Delete document (cascade via FK)
	.delete("/documents/:id", async ({ params, set, request }) => {
		const ip =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"unknown";
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
		if (!canAccessContent(access, "write")) {
			set.status = 403;
			return { error: "Forbidden" };
		}
		const userId = ctx.userId;
		try {
			const deleted = await withTenant(ctx, async (tx) => {
				const existing = await tx
					.select({ id: documents.id })
					.from(documents)
					.where(
						and(
							eq(documents.id, params.id),
							eq(documents.ownerId, userId),
							...(access.restricted && access.categoryId
								? [eq(documents.categoryId, access.categoryId)]
								: []),
						),
					)
					.limit(1);
				if (existing.length === 0) {
					return false;
				}
				await tx
					.delete(documents)
					.where(
						and(eq(documents.id, params.id), eq(documents.ownerId, userId)),
					);
				return true;
			});
			if (!deleted) {
				set.status = 404;
				return { error: "Document not found" };
			}
			invalidateDocCache(params.id);
			invalidateDocListCache(userId);

			const ipAddress =
				request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
				request.headers.get("x-real-ip") ??
				"";
			const userAgent = request.headers.get("user-agent") ?? "";
			recordAuditEvent({
				actorId: userId,
				action: "document.delete",
				resourceType: "document",
				resourceId: params.id,
				details: {},
				ipAddress,
				userAgent,
			}).catch(() => {});

			return { success: true };
		} catch (err) {
			logger.error({ err }, "Failed to delete document");
			set.status = 500;
			return { error: "Failed to delete document" };
		}
	})

	.get("/documents/:id/export", async ({ params, set, request }) => {
		const access = await resolveContentAccess(request);
		const ctx = access.ctx;
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		if (!canAccessContent(access, "read")) {
			set.status = 403;
			return { error: "Forbidden" };
		}
		const userId = ctx.userId;
		try {
			const doc = await withTenant(ctx, async (tx) => {
				const rows = await tx
					.select({
						id: documents.id,
						title: documents.title,
						content: documents.content,
					})
					.from(documents)
					.where(
						and(
							eq(documents.id, params.id),
							eq(documents.ownerId, userId),
							...(access.restricted && access.categoryId
								? [eq(documents.categoryId, access.categoryId)]
								: []),
						),
					)
					.limit(1);
				return rows[0];
			});
			if (!doc) {
				set.status = 404;
				return { error: "Document not found" };
			}
			const filename = `${doc.title.replace(/[^a-zA-Z0-9-_]/g, "_")}.md`;
			set.headers = {
				"Content-Type": "text/markdown; charset=utf-8",
				"Content-Disposition": `attachment; filename="${filename}"`,
			};
			return doc.content ?? "";
		} catch (err) {
			logger.error({ err }, "Failed to export document");
			set.status = 500;
			return { error: "Failed to export document" };
		}
	})

	.post("/documents/import", async ({ request, set }) => {
		const importRequestId = crypto.randomUUID();
		const ip =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"unknown";
		const rl = await writeRateLimiter(ip, request);
		if (!rl.allowed) {
			set.status = 429;
			set.headers = rateLimitHeaders(0, rl.retryAfter);
			return { error: "Too many requests" };
		}
		set.headers = rateLimitHeaders(rl.remaining);
		set.headers["X-Request-ID"] = importRequestId;

		const access = await resolveContentAccess(request);
		const ctx = access.ctx;
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		if (!canAccessContent(access, "write")) {
			set.status = 403;
			return { error: "Forbidden" };
		}
		const userId = ctx.userId;
		let importItemCount = 0;
		let importByteCount = 0;
		try {
			const contentType = request.headers.get("content-type") ?? "";
			const contentLength = Number(request.headers.get("content-length"));
			if (
				Number.isFinite(contentLength) &&
				contentLength > MAX_IMPORT_REQUEST_SIZE
			) {
				set.status = 413;
				return {
					error: `Import request too large. Maximum total size: ${MAX_IMPORT_REQUEST_SIZE / 1024 / 1024}MB`,
				};
			}

			// Per-item import result. `filename` is captured from the
			// uploaded `File.name` for multipart uploads, and synthesized
			// from the title (`.md` suffix) for the JSON single-item path
			// so the response can echo a stable per-file identifier the
			// client uses to reconcile its progress UI.
			type ImportedItem = {
				filename: string;
				title: string;
				content: string;
			};
			let items: ImportedItem[];
			let folderId: string | null = null;

			if (contentType.includes("application/json")) {
				let body: unknown;
				try {
					body = await request.json();
				} catch {
					set.status = 400;
					return { error: "Invalid JSON syntax" };
				}
				const parsed = importJsonSchema.safeParse(body);
				if (!parsed.success) {
					set.status = 400;
					return {
						error: "Invalid import data",
						details: parsed.error.flatten(),
					};
				}
				const jsonTitle = parsed.data.title ?? "Imported Document";
				assertImportContentSize(parsed.data.content, `${jsonTitle}.md`);
				importItemCount = 1;
				importByteCount = Buffer.byteLength(parsed.data.content, "utf8");
				items = [
					{
						filename: `${jsonTitle}.md`,
						title: jsonTitle,
						content: parsed.data.content,
					},
				];
				folderId = parsed.data.folderId ?? null;
			} else if (contentType.includes("multipart/form-data")) {
				const formData = await request.formData();
				// `formData.getAll("file")` returns every uploaded file in
				// order. A single-file upload still works (array of length 1)
				// so backward compatibility is preserved.
				const files = formData.getAll("file") as File[];
				if (files.length === 0) {
					set.status = 400;
					return { error: "At least one file is required" };
				}
				if (files.length > MAX_IMPORT_FILES) {
					set.status = 413;
					return {
						error: `Too many files. Maximum per import: ${MAX_IMPORT_FILES}`,
					};
				}
				const totalFileSize = files.reduce((sum, file) => sum + file.size, 0);
				importItemCount = files.length;
				importByteCount = totalFileSize;
				if (totalFileSize > MAX_IMPORT_REQUEST_SIZE) {
					set.status = 413;
					return {
						error: `Import request too large. Maximum total size: ${MAX_IMPORT_REQUEST_SIZE / 1024 / 1024}MB`,
					};
				}
				const rawFolderId = formData.get("folderId");
				if (rawFolderId !== null && rawFolderId !== undefined) {
					const folderCheck = z.string().uuid().safeParse(String(rawFolderId));
					if (!folderCheck.success) {
						set.status = 400;
						return { error: "Invalid folderId" };
					}
					folderId = folderCheck.data;
				}

				items = [];
				for (const file of files) {
					if (file.size > MAX_IMPORT_SIZE) {
						set.status = 413;
						return {
							error: `File "${file.name}" too large. Maximum size: ${MAX_IMPORT_SIZE / 1024 / 1024}MB`,
						};
					}
					const ext = `.${file.name.split(".").pop()?.toLowerCase()}`;
					if (!ALLOWED_IMPORT_EXTENSIONS.includes(ext)) {
						set.status = 415;
						return {
							error: `Invalid file type for "${file.name}". Allowed: ${ALLOWED_IMPORT_EXTENSIONS.join(", ")}`,
						};
					}
					const parsedItem = await importFileToItem(file);
					items.push({
						filename: file.name,
						title: parsedItem.title,
						content: parsedItem.content,
					});
				}
			} else {
				set.status = 415;
				return {
					error:
						"Unsupported content type. Use application/json or multipart/form-data",
				};
			}

			if (items.length === 0) {
				set.status = 400;
				return { error: "No importable items supplied" };
			}

			let resolvedCategoryId: string | null = null;
			if (folderId) {
				resolvedCategoryId = await resolveFolderCategory(ctx, folderId);
			}
			if (!isAuthorizedCategory(access, resolvedCategoryId)) {
				set.status = 403;
				return { error: "Forbidden" };
			}

			// All-or-nothing batch create. If any insert fails, the whole
			// transaction rolls back and the client can retry without
			// worrying about partial imports leaving the DB inconsistent.
			// We zip each created row with its source item so the response
			// builder below never has to index into a parallel array
			// (which would otherwise require non-null assertions under
			// `noUncheckedIndexedAccess`).
			type CreatedEntry = {
				item: ImportedItem;
				row: { id: string; title: string; revision: string };
			};
			const created = await withTenant(ctx, async (tx) => {
				const out: CreatedEntry[] = [];
				for (const item of items) {
					const revision = contentHash(item.title, item.content);
					const [row] = await tx
						.insert(documents)
						.values({
							ownerId: userId,
							title: item.title,
							content: item.content,
							contentHash: revision,
							folderId,
							categoryId: resolvedCategoryId,
						})
						.returning({ id: documents.id, title: documents.title });
					if (!row) {
						throw new Error(`Failed to insert document "${item.title}"`);
					}
					await tx.insert(versions).values({
						documentId: row.id,
						content: item.content,
						createdBy: userId,
					});
					out.push({
						item,
						row: { ...row, revision },
					});
				}
				return out;
			});

			// Embedding enqueue happens AFTER the transaction commits so
			// embeddings never get computed for documents that were rolled
			// back. We deliberately don't await — embedding is a background
			// job and shouldn't block the import response.
			for (const { row } of created) {
				void enqueueDocumentPipeline({
					documentId: row.id,
					ownerId: userId,
					revision: row.revision,
					source: "import",
				}).catch((err) =>
					logger.warn({ err, documentId: row.id }, "Pipeline enqueue failed"),
				);
			}

			set.status = 201;
			// Per-file result envelope. The frontend reconciles its
			// progress overlay by matching on `filename` (see
			// `frontend/src/routes/(app)/+page.svelte` and
			// `frontend/src/lib/api/documents.ts:ImportResponse`), so
			// every accepted file must round-trip with the same name it
			// had on disk (multipart path) or a stable synthesized
			// fallback (JSON path). The all-or-nothing transaction above
			// guarantees every result here is a success — any failure
			// short-circuits to the catch block with a 4xx/5xx status.
			const now = new Date().toISOString();
			const results = created.map(({ item, row }) => ({
				filename: item.filename,
				status: "ok" as const,
				document: {
					id: row.id,
					title: row.title,
					content: item.content,
					createdAt: now,
					updatedAt: now,
				},
			}));
			return {
				items: results,
				imported: results.length,
				failed: 0,
			};
		} catch (err: unknown) {
			if (err instanceof ImportInputError) {
				set.status = err.status;
				return { error: err.message };
			}
			// DOCX parsing failures are user-actionable (bad file, encrypted
			// doc) so we surface them as 422 with a descriptive message
			// rather than collapsing them into a generic 500.
			if (err instanceof DocxParseError) {
				logger.warn(
					{
						requestId: importRequestId,
						kind: "docx_parse",
						itemCount: importItemCount,
						sizeBucket: byteSizeBucket(importByteCount),
					},
					"DOCX parse failure during import",
				);
				set.status = 422;
				return { error: err.message };
			}
			const telemetry = importErrorTelemetry(err);
			logger.error(
				{
					requestId: importRequestId,
					kind: telemetry.kind,
					code: telemetry.code,
					itemCount: importItemCount,
					sizeBucket: byteSizeBucket(importByteCount),
				},
				"Failed to import document",
			);
			if (telemetry.code === "54000") {
				set.status = 422;
				return {
					error:
						"Document text is too large for the search index. Remove embedded data images or split the document.",
				};
			}
			set.status = 500;
			return { error: "Failed to import document" };
		}
	});
