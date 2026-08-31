import { CopyObjectCommand } from "@aws-sdk/client-s3";
import {
	attachmentStorageCleanupOutbox,
	attachments,
	categories,
	documentCreateOperations,
	documentEmbeddings,
	documentKnowledgeSummaries,
	documentPipelineRuns,
	documents,
	documentTags,
	folders,
	pendingAttachmentUploads,
	tags,
	versions,
} from "@hiai-docs/db/schema";
import {
	and,
	asc,
	count,
	desc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lt,
	or,
	sql,
} from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";
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
	type PendingAttachmentUploadRow,
	stagePendingAttachmentCleanup,
} from "../../lib/attachment-upload-cleanup";
import { recordAuditEvent } from "../../lib/audit";
import { config } from "../../lib/config";
import {
	canAccessContent,
	effectiveDocumentCategoryCondition,
	isAuthorizedCategory,
	resolveContentAccess,
	resolveFolderEffectiveCategory,
	tenantOwnerCondition,
} from "../../lib/content-access";
import { contentHash } from "../../lib/content-hash";
import {
	cacheGetOrSet,
	cacheHttpResponse,
	docListKey,
	docSingleKey,
	invalidateDocCache,
	invalidateDocListCache,
} from "../../lib/doc-cache";
import {
	documentCreateIdempotencyKey,
	documentCreateWorkspaceIdentity,
} from "../../lib/document-create-idempotency";
import { acquireDocumentPipelineLock } from "../../lib/document-pipeline-serialization";
import { DocxParseError, docxToMarkdown } from "../../lib/docx-parser";
import {
	encodeS3CopySource,
	planDuplicateAttachments,
	rewriteDuplicateAttachmentReferences,
} from "../../lib/duplicate-attachments";
import { logger } from "../../lib/logger";
import { isRetryablePipelineError } from "../../lib/pipeline-error";
import {
	dispatchMetadataReembedOutbox,
	enqueueReembed,
	metadataReembedPageSize,
	snapshotDocumentMetadataImpact,
} from "../../lib/reembed";
import {
	getDocsMintRuntimeOptions,
	isRetryableQuotaError,
} from "../../lib/runtime-options";
import { BUCKET, storage } from "../../lib/storage";
import { acquireTenantTopologyLock } from "../../lib/topology-serialization";
import { maybePruneVersions } from "../../lib/version-prune";
import { withTenant } from "../../lib/with-tenant";
import {
	JOB_IDS,
	PIPELINE_SCHEMA_VERSION,
	type PipelineJob,
} from "../../queue/contracts";
import { enqueueDocumentPipeline } from "../../queue/enqueue";
import { DEFAULT_JOB_OPTIONS, SOURCE_PRIORITY } from "../../queue/names";
import { planWarningStageRetry } from "../../queue/pipeline-warning-retry";
import { getPipelineQueue } from "../../queue/queues";
import {
	documentRateLimiter,
	rateLimitHeaders,
	writeRateLimiter,
} from "../middleware/rate-limit";

type SingleDocumentCacheBody =
	| Readonly<{ error: string }>
	| Readonly<{
			content: string | null;
			contentJson: unknown;
			[key: string]: unknown;
	  }>;

class DocumentPurgeNotFoundError extends Error {
	constructor() {
		super("document_purge_not_found");
		this.name = "DocumentPurgeNotFoundError";
	}
}

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
	// Optional optimistic-concurrency token sent by the offline mutation
	// queue. When provided, the handler rejects with 409 if the document's
	// current `updatedAt` differs from this value (i.e. it changed on the
	// server after the client's edit was based on it).
	expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

const listQuerySchema = z.object({
	folderId: z.string().uuid().optional(),
	tag: z.string().uuid().optional(),
	page: z.coerce.number().int().min(1).default(1),
	limit: z.coerce.number().int().min(1).max(1000).default(20),
});

const cursorListQuerySchema = z.object({
	categoryId: z.string().uuid().optional(),
	cursor: z.string().min(1).optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	sortBy: z.enum(["title", "category", "folder", "updated"]).default("updated"),
	sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

const documentIdParamsSchema = z.object({ id: z.string().uuid() });

type DocumentCursorV2 = Readonly<{
	v: 2;
	sortBy: "title" | "category" | "folder" | "updated";
	sortOrder: "asc" | "desc";
	value: string | null;
	id: string;
	scopeHash: string;
}>;

function cursorScopeHash(input: string): string {
	return Buffer.from(
		new Bun.CryptoHasher("sha256").update(input).digest("hex"),
		"utf8",
	).toString("base64url");
}

function decodeDocumentCursor(
	value: string,
	expectedScopeHash: string,
): DocumentCursorV2 {
	let cursor: unknown;
	try {
		cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
	} catch {
		throw new Error("Malformed cursor");
	}
	if (!cursor || typeof cursor !== "object")
		throw new Error("Malformed cursor");
	const candidate = cursor as Record<string, unknown>;
	if (
		candidate.v !== 2 ||
		!["title", "category", "folder", "updated"].includes(
			String(candidate.sortBy),
		) ||
		!["asc", "desc"].includes(String(candidate.sortOrder)) ||
		(candidate.value !== null && typeof candidate.value !== "string") ||
		typeof candidate.id !== "string" ||
		typeof candidate.scopeHash !== "string" ||
		candidate.scopeHash !== expectedScopeHash
	) {
		throw new Error("Cursor does not match this listing scope");
	}
	return candidate as DocumentCursorV2;
}

function encodeDocumentCursor(cursor: DocumentCursorV2): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

const ALLOWED_IMPORT_EXTENSIONS = [".md", ".txt", ".json", ".docx"];
const MAX_IMPORT_SIZE = 10 * 1024 * 1024;
const MAX_IMPORT_FILES = 10;
const MAX_IMPORT_REQUEST_SIZE = 50 * 1024 * 1024;
const MAX_EXTRACTED_CONTENT_SIZE = 25 * 1024 * 1024;

class ImportInputError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 403 | 413 | 415 | 422,
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
 *   - .md / .txt: read as text, derive title from filename.
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
		title: name.replace(/\.(md|txt)$/i, ""),
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
		const cacheKey = `${docListKey(userId, folderId, tag, page, limit, ctx.workspaceId)}:scope:${access.categoryId ?? "all"}`;
		try {
			return await cacheGetOrSet(cacheKey, 30, async () => {
				const conditions = [
					tenantOwnerCondition(documents.ownerId, documents.workspaceId, ctx),
					isNull(documents.deletedAt),
				];
				if (access.restricted) {
					conditions.push(
						access.categoryId
							? effectiveDocumentCategoryCondition(
									documents.categoryId,
									documents.folderId,
									ctx,
									access.categoryId,
								)
							: sql`false`,
					);
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
	// GET /api/documents/cursor — bounded, scope-bound cursor listing.
	.get("/documents/cursor", async ({ query, request, set }) => {
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
		const parsed = cursorListQuerySchema.safeParse(query);
		if (!parsed.success) {
			set.status = 400;
			return { error: "Invalid query", details: parsed.error.flatten() };
		}
		const {
			categoryId,
			cursor: encodedCursor,
			limit,
			sortBy,
			sortOrder,
		} = parsed.data;
		const effectiveCategoryId = access.restricted
			? (access.categoryId ?? categoryId)
			: categoryId;
		const scopeHash = cursorScopeHash(
			JSON.stringify({
				workspaceId: ctx.workspaceId ?? null,
				actorUserId: access.userId,
				categoryId: effectiveCategoryId ?? null,
				sortBy,
				sortOrder,
			}),
		);
		let cursor: DocumentCursorV2 | undefined;
		if (encodedCursor) {
			try {
				cursor = decodeDocumentCursor(encodedCursor, scopeHash);
			} catch (error) {
				set.status = 400;
				return {
					error: error instanceof Error ? error.message : "Malformed cursor",
				};
			}
		}
		const sortValue =
			sortBy === "title"
				? sql<string>`lower(${documents.title})`
				: sortBy === "category"
					? sql<string | null>`lower(${categories.name})`
					: sortBy === "folder"
						? sql<string | null>`lower(${folders.name})`
						: sql<Date>`${documents.updatedAt}`;
		const conditions = [
			tenantOwnerCondition(documents.ownerId, documents.workspaceId, ctx),
			isNull(documents.deletedAt),
			...(effectiveCategoryId
				? [
						effectiveDocumentCategoryCondition(
							documents.categoryId,
							documents.folderId,
							ctx,
							effectiveCategoryId,
						),
					]
				: []),
		];
		if (cursor) {
			const idAfter =
				sortOrder === "asc"
					? gt(documents.id, cursor.id)
					: lt(documents.id, cursor.id);
			if (sortBy === "updated" && cursor.value) {
				const cursorDate = new Date(cursor.value);
				const valueAfter =
					sortOrder === "asc"
						? gt(documents.updatedAt, cursorDate)
						: lt(documents.updatedAt, cursorDate);
				const cursorCondition = or(
					valueAfter,
					and(eq(documents.updatedAt, cursorDate), idAfter),
				);
				if (cursorCondition) conditions.push(cursorCondition);
			} else if (cursor.value === null) {
				const cursorCondition = and(isNull(sortValue), idAfter);
				if (cursorCondition) conditions.push(cursorCondition);
			} else {
				const valueAfter =
					sortOrder === "asc"
						? gt(sortValue, cursor.value)
						: lt(sortValue, cursor.value);
				const cursorCondition = or(
					valueAfter,
					and(eq(sortValue, cursor.value), idAfter),
					isNull(sortValue),
				);
				if (cursorCondition) conditions.push(cursorCondition);
			}
		}
		try {
			const rows = await withTenant(ctx, (tx) =>
				tx
					.select({
						id: documents.id,
						title: documents.title,
						content: sql<string>`LEFT(${documents.content}, 200)`.as("content"),
						folderId: documents.folderId,
						folderName: folders.name,
						categoryId: documents.categoryId,
						categoryName: categories.name,
						createdAt: documents.createdAt,
						updatedAt: documents.updatedAt,
					})
					.from(documents)
					.leftJoin(folders, eq(folders.id, documents.folderId))
					.leftJoin(categories, eq(categories.id, documents.categoryId))
					.where(and(...conditions))
					.orderBy(
						sortOrder === "asc"
							? sql`${sortValue} asc nulls last`
							: sql`${sortValue} desc nulls last`,
						sortOrder === "asc" ? asc(documents.id) : desc(documents.id),
					)
					.limit(limit + 1),
			);
			const hasMore = rows.length > limit;
			const page = rows.slice(0, limit);
			const last = page.at(-1);
			const lastValue = last
				? sortBy === "title"
					? last.title.toLocaleLowerCase()
					: sortBy === "category"
						? (last.categoryName?.toLocaleLowerCase() ?? null)
						: sortBy === "folder"
							? (last.folderName?.toLocaleLowerCase() ?? null)
							: new Date(last.updatedAt).toISOString()
				: null;
			return {
				items: await withTags(ctx, page),
				nextCursor:
					hasMore && last
						? encodeDocumentCursor({
								v: 2,
								sortBy,
								sortOrder,
								value: lastValue,
								id: last.id,
								scopeHash,
							})
						: null,
			};
		} catch (error) {
			logger.error({ error }, "Failed to list cursor documents");
			set.status = 500;
			return { error: "Failed to list documents" };
		}
	})

	// POST /api/documents — Create document + initial version
	.post("/documents", async ({ request, set }) => {
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
		const idempotencyKey = documentCreateIdempotencyKey(request);
		if (idempotencyKey === "invalid") {
			set.status = 400;
			return { error: "Invalid Idempotency-Key" };
		}
		if (idempotencyKey) {
			const workspaceIdentity = documentCreateWorkspaceIdentity(
				userId,
				ctx.workspaceId,
			);
			const replay = await withTenant(ctx, async (tx) => {
				const authorized =
					and(
						tenantOwnerCondition(documents.ownerId, documents.workspaceId, ctx),
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
					) ?? sql`false`;
				const [existing] = await tx
					.select({ document: documents, authorized })
					.from(documentCreateOperations)
					.innerJoin(
						documents,
						eq(documentCreateOperations.documentId, documents.id),
					)
					.where(
						and(
							eq(documentCreateOperations.workspaceId, workspaceIdentity),
							eq(documentCreateOperations.actorUserId, userId),
							eq(documentCreateOperations.idempotencyKey, idempotencyKey),
						),
					)
					.limit(1);
				return existing ?? null;
			});
			if (replay?.authorized) {
				set.status = 200;
				return replay.document;
			}
			if (replay) {
				set.status = 409;
				return { error: "Idempotency key is unavailable" };
			}
		}

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
			const requestedCategoryId = body.data.categoryId ?? null;

			const createdResult = await withTenant(ctx, async (tx) => {
				if (folderId || requestedCategoryId) {
					await acquireTenantTopologyLock(tx, ctx);
				}
				let categoryId = requestedCategoryId;
				if (folderId && !categoryId) {
					const resolvedCategoryId = await resolveFolderEffectiveCategory(
						tx,
						ctx,
						folderId,
					);
					if (resolvedCategoryId === undefined) {
						return {
							row: null,
							replayed: false,
							conflict: false,
							forbidden: true,
						};
					}
					categoryId = resolvedCategoryId;
				}
				if (!isAuthorizedCategory(access, categoryId)) {
					return {
						row: null,
						replayed: false,
						conflict: false,
						forbidden: true,
					};
				}
				const workspaceIdentity = documentCreateWorkspaceIdentity(
					userId,
					ctx.workspaceId,
				);
				if (idempotencyKey) {
					// Serialize the full create transaction for this verified actor,
					// workspace and key. The operation row, document and first version
					// therefore commit together; a rollback leaves no reservation.
					await tx.execute(
						sql`SELECT pg_advisory_xact_lock(hashtext(${`${workspaceIdentity}:${userId}:${idempotencyKey}`}))`,
					);
					const authorized =
						and(
							tenantOwnerCondition(
								documents.ownerId,
								documents.workspaceId,
								ctx,
							),
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
						) ?? sql`false`;
					const [existing] = await tx
						.select({ document: documents, authorized })
						.from(documentCreateOperations)
						.innerJoin(
							documents,
							eq(documentCreateOperations.documentId, documents.id),
						)
						.where(
							and(
								eq(documentCreateOperations.workspaceId, workspaceIdentity),
								eq(documentCreateOperations.actorUserId, userId),
								eq(documentCreateOperations.idempotencyKey, idempotencyKey),
							),
						)
						.limit(1);
					if (existing?.authorized) {
						return {
							row: existing.document,
							replayed: true,
							conflict: false,
							forbidden: false,
						};
					}
					if (existing) {
						return {
							row: null,
							replayed: false,
							conflict: true,
							forbidden: false,
						};
					}
				}
				const [row] = await tx
					.insert(documents)
					.values({
						ownerId: userId,
						// Persist the verified tenant on the primary row as well as in
						// the idempotency operation. The database default does the same
						// for external contexts; stating it here makes the boundary
						// explicit and keeps the operation/document pair coherent.
						workspaceId: ctx.workspaceId ?? null,
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
				if (idempotencyKey) {
					await tx.insert(documentCreateOperations).values({
						workspaceId: workspaceIdentity,
						actorUserId: userId,
						idempotencyKey,
						documentId: row.id,
					});
				}
				return { row, replayed: false, conflict: false, forbidden: false };
			});
			if (createdResult.forbidden) {
				set.status = 403;
				return { error: "Forbidden" };
			}
			if (createdResult.conflict || !createdResult.row) {
				set.status = 409;
				return { error: "Idempotency key is unavailable" };
			}
			const created = createdResult.row;
			if (createdResult.replayed) {
				set.status = 200;
				return created;
			}

			void enqueueDocumentPipeline({
				documentId: created.id,
				ownerId: userId,
				workspaceId: ctx.workspaceId,
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
			if (isAccountPurgeFencedError(err)) {
				set.status = 409;
				return accountPurgeFencedResponse();
			}
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
						graphErrorCode: documentPipelineRuns.graphErrorCode,
						summarizeErrorCode: documentPipelineRuns.summarizeErrorCode,
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
				warnings: [
					...(run.graphStatus === "failed"
						? [
								{
									stage: "graph" as const,
									code: run.graphErrorCode ?? "graph_failed",
									retryable: isRetryablePipelineError(
										run.graphErrorCode ?? "graph_failed",
									),
								},
							]
						: []),
					...(run.summarizeStatus === "failed"
						? [
								{
									stage: "summarize" as const,
									code: run.summarizeErrorCode ?? "summary_failed",
									retryable: isRetryablePipelineError(
										run.summarizeErrorCode ?? "summary_failed",
									),
								},
							]
						: []),
				],
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
	.post(
		"/documents/:id/pipeline/retry-warnings",
		async ({ params, set, request }) => {
			const parsedParams = documentIdParamsSchema.safeParse(params);
			if (!parsedParams.success) {
				set.status = 400;
				return { error: "Invalid document id" };
			}
			const documentId = parsedParams.data.id;
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
			let claimed:
				| { generationId: string; graph: boolean; summarize: boolean }
				| undefined;
			try {
				const retry = await withTenant(ctx, async (tx) => {
					await acquireDocumentPipelineLock(tx, documentId);
					const [run] = await tx
						.select({
							generationId: documentPipelineRuns.generationId,
							revision: documentPipelineRuns.revision,
							ownerId: documentPipelineRuns.ownerId,
							workspaceId: documentPipelineRuns.workspaceId,
							refreshMode: documentPipelineRuns.refreshMode,
							embeddingContextHash: documentPipelineRuns.embeddingContextHash,
							embedStatus: documentPipelineRuns.embedStatus,
							graphStatus: documentPipelineRuns.graphStatus,
							summarizeStatus: documentPipelineRuns.summarizeStatus,
							graphErrorCode: documentPipelineRuns.graphErrorCode,
							summarizeErrorCode: documentPipelineRuns.summarizeErrorCode,
						})
						.from(documentPipelineRuns)
						.innerJoin(
							documents,
							and(
								eq(documents.id, documentPipelineRuns.documentId),
								eq(
									documents.activeEmbeddingGeneration,
									documentPipelineRuns.generationId,
								),
							),
						)
						.where(
							and(
								eq(documentPipelineRuns.documentId, documentId),
								tenantOwnerCondition(
									documents.ownerId,
									documents.workspaceId,
									ctx,
								),
								eq(documentPipelineRuns.status, "ready_with_warnings"),
								eq(documentPipelineRuns.embedStatus, "ready"),
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
						.orderBy(desc(documentPipelineRuns.updatedAt))
						.limit(1)
						.for("update");
					if (!run) return null;
					const plan = planWarningStageRetry(run);
					if (!plan) return null;
					const { graph, summarize } = plan;
					await tx
						.update(documentPipelineRuns)
						.set({
							status: "processing",
							finalizeStatus: "pending",
							...(graph
								? { graphStatus: "retrying" as const, graphErrorCode: null }
								: {}),
							...(summarize
								? {
										summarizeStatus: "retrying" as const,
										summarizeErrorCode: null,
									}
								: {}),
							updatedAt: new Date(),
						})
						.where(eq(documentPipelineRuns.generationId, run.generationId));
					return { ...run, graph, summarize };
				});
				if (!retry) {
					set.status = 409;
					return { error: "No retryable warning stages" };
				}
				claimed = retry;
				const stage = retry.graph ? "graph" : "summarize";
				for (const [queuedStage, jobId] of [
					[
						"graph",
						JOB_IDS.graph(retry.generationId, retry.workspaceId ?? undefined),
					],
					[
						"summarize",
						JOB_IDS.summarize(
							retry.generationId,
							retry.workspaceId ?? undefined,
						),
					],
					[
						"finalize",
						JOB_IDS.finalize(
							retry.generationId,
							retry.workspaceId ?? undefined,
						),
					],
				] as const) {
					const oldJob = await getPipelineQueue(
						queuedStage,
						config.REDIS_URL,
					).getJob(jobId);
					await oldJob?.remove();
				}
				const queue = getPipelineQueue(stage, config.REDIS_URL);
				const data: PipelineJob = {
					schemaVersion: PIPELINE_SCHEMA_VERSION,
					stage,
					documentId,
					ownerId: retry.ownerId,
					...(retry.workspaceId ? { workspaceId: retry.workspaceId } : {}),
					generationId: retry.generationId,
					revision: retry.revision,
					requestedAt: new Date().toISOString(),
					source: "api",
					refreshMode:
						retry.refreshMode === "incremental" ? "incremental" : "full",
					...(retry.embeddingContextHash
						? { embeddingContextHash: retry.embeddingContextHash }
						: {}),
				};
				await queue.add(stage, data, {
					...DEFAULT_JOB_OPTIONS,
					jobId: `${stage}-warning-retry-${retry.generationId}-${Date.now()}`,
					priority: SOURCE_PRIORITY.api,
				});
				return {
					documentId,
					generationId: retry.generationId,
					retriedStages: [
						...(retry.graph ? (["graph"] as const) : []),
						...(retry.summarize ? (["summarize"] as const) : []),
					],
				};
			} catch (err) {
				const failedClaim = claimed;
				if (failedClaim) {
					await withTenant(ctx, (tx) =>
						tx
							.update(documentPipelineRuns)
							.set({
								status: "ready_with_warnings",
								finalizeStatus: "ready",
								...(failedClaim.graph
									? {
											graphStatus: "failed" as const,
											graphErrorCode: "queue_enqueue_failed",
										}
									: {}),
								...(failedClaim.summarize
									? {
											summarizeStatus: "failed" as const,
											summarizeErrorCode: "queue_enqueue_failed",
										}
									: {}),
								updatedAt: new Date(),
							})
							.where(
								and(
									eq(
										documentPipelineRuns.generationId,
										failedClaim.generationId,
									),
									eq(documentPipelineRuns.status, "processing"),
								),
							),
					).catch(() => undefined);
				}
				logger.error({ err, documentId }, "Failed to retry warning stages");
				set.status = 500;
				return { error: "Failed to retry warning stages" };
			}
		},
	)
	.get("/documents/:id/knowledge-summary", async ({ params, set, request }) => {
		const parsedParams = documentIdParamsSchema.safeParse(params);
		if (!parsedParams.success) {
			set.status = 400;
			return { error: "Invalid document id" };
		}
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
		const [summary] = await withTenant(ctx, (tx) =>
			tx
				.select({
					documentId: documentKnowledgeSummaries.document_id,
					generationId: documentKnowledgeSummaries.generation_id,
					revision: documentKnowledgeSummaries.revision,
					language: documentKnowledgeSummaries.language,
					description: documentKnowledgeSummaries.description,
					keywords: documentKnowledgeSummaries.keywords,
					createdAt: documentKnowledgeSummaries.created_at,
					updatedAt: documentKnowledgeSummaries.updated_at,
				})
				.from(documentKnowledgeSummaries)
				.innerJoin(
					documents,
					eq(documents.id, documentKnowledgeSummaries.document_id),
				)
				.where(
					and(
						eq(documentKnowledgeSummaries.document_id, parsedParams.data.id),
						eq(
							documentKnowledgeSummaries.generation_id,
							documents.activeEmbeddingGeneration,
						),
						tenantOwnerCondition(documents.ownerId, documents.workspaceId, ctx),
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
				.limit(1),
		);
		if (!summary) {
			set.status = 404;
			return { error: "Knowledge summary not found" };
		}
		return summary;
	})
	.get("/documents/:id/index-status", async ({ params, set, request }) => {
		const parsedParams = documentIdParamsSchema.safeParse(params);
		if (!parsedParams.success) {
			set.status = 400;
			return { error: "Invalid document id" };
		}
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
		const result = await withTenant(ctx, async (tx) => {
			const [document] = await tx
				.select({
					id: documents.id,
					embeddingStatus: documents.embeddingStatus,
					activeGenerationId: documents.activeEmbeddingGeneration,
					pendingGenerationId: documents.pendingEmbeddingGeneration,
					embeddingProfile: documents.embeddingProfile,
					embeddingErrorCode: documents.embeddingErrorCode,
					embeddingUpdatedAt: documents.embeddingUpdatedAt,
				})
				.from(documents)
				.where(
					and(
						eq(documents.id, parsedParams.data.id),
						tenantOwnerCondition(documents.ownerId, documents.workspaceId, ctx),
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
			if (!document) return null;
			const active = document.activeGenerationId
				? await tx
						.select({ id: documentEmbeddings.id })
						.from(documentEmbeddings)
						.where(
							and(
								eq(documentEmbeddings.documentId, document.id),
								eq(
									documentEmbeddings.generationId,
									document.activeGenerationId,
								),
								eq(documentEmbeddings.isValid, true),
								eq(documentEmbeddings.embeddingDimensions, 1024),
								eq(
									documentEmbeddings.embeddingProfile,
									document.embeddingProfile ?? "",
								),
							),
						)
						.limit(1)
				: [];
			const [run] = await tx
				.select({
					documentId: documentPipelineRuns.documentId,
					generationId: documentPipelineRuns.generationId,
					revision: documentPipelineRuns.revision,
					status: documentPipelineRuns.status,
					prepareStatus: documentPipelineRuns.prepareStatus,
					embedStatus: documentPipelineRuns.embedStatus,
					graphStatus: documentPipelineRuns.graphStatus,
					summarizeStatus: documentPipelineRuns.summarizeStatus,
					graphErrorCode: documentPipelineRuns.graphErrorCode,
					summarizeErrorCode: documentPipelineRuns.summarizeErrorCode,
					finalizeStatus: documentPipelineRuns.finalizeStatus,
					totalBatches: documentPipelineRuns.totalBatches,
					completedBatches: documentPipelineRuns.completedBatches,
					failedBatches: documentPipelineRuns.failedBatches,
					updatedAt: documentPipelineRuns.updatedAt,
				})
				.from(documentPipelineRuns)
				.where(eq(documentPipelineRuns.documentId, document.id))
				.orderBy(desc(documentPipelineRuns.updatedAt))
				.limit(1);
			return {
				document,
				searchable: active.length > 0,
				run,
			};
		});
		if (!result) {
			set.status = 404;
			return { error: "Document not found" };
		}
		const run = result.run;
		return {
			documentId: result.document.id,
			embeddingStatus: result.document.embeddingStatus,
			activeGenerationId: result.document.activeGenerationId,
			pendingGenerationId: result.document.pendingGenerationId,
			embeddingProfile: result.document.embeddingProfile,
			embeddingErrorCode: result.document.embeddingErrorCode,
			embeddingUpdatedAt: result.document.embeddingUpdatedAt,
			searchable: result.searchable,
			pipeline: run
				? {
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
						warnings: [
							...(run.graphStatus === "failed"
								? [
										{
											stage: "graph" as const,
											code: run.graphErrorCode ?? "graph_failed",
											retryable: isRetryablePipelineError(
												run.graphErrorCode ?? "graph_failed",
											),
										},
									]
								: []),
							...(run.summarizeStatus === "failed"
								? [
										{
											stage: "summarize" as const,
											code: run.summarizeErrorCode ?? "summary_failed",
											retryable: isRetryablePipelineError(
												run.summarizeErrorCode ?? "summary_failed",
											),
										},
									]
								: []),
						],
						updatedAt: run.updatedAt,
					}
				: null,
		};
	})
	.post("/documents/:id/index/refresh", async ({ params, set, request }) => {
		const parsedParams = documentIdParamsSchema.safeParse(params);
		if (!parsedParams.success) {
			set.status = 400;
			return { error: "Invalid document id" };
		}
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
		const [document] = await withTenant(ctx, (tx) =>
			tx
				.select({
					id: documents.id,
					ownerId: documents.ownerId,
					title: documents.title,
					content: documents.content,
				})
				.from(documents)
				.where(
					and(
						eq(documents.id, parsedParams.data.id),
						tenantOwnerCondition(documents.ownerId, documents.workspaceId, ctx),
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
				.limit(1),
		);
		if (!document) {
			set.status = 404;
			return { error: "Document not found" };
		}
		const queued = await enqueueDocumentPipeline({
			documentId: document.id,
			ownerId: document.ownerId,
			workspaceId: ctx.workspaceId,
			revision: contentHash(document.title, document.content ?? ""),
			source: "api",
		});
		set.status = 202;
		return { documentId: document.id, ...queued };
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
			const response = await cacheHttpResponse<SingleDocumentCacheBody>(
				`${docSingleKey(params.id, userId, ctx.workspaceId)}:scope:${access.categoryId ?? "all"}`,
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
									tenantOwnerCondition(
										documents.ownerId,
										documents.workspaceId,
										ctx,
									),
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
						return {
							status: 404,
							body: { error: "Document not found" },
						};
					}
					return { status: 200, body: result };
				},
				{
					// Large imported documents are already stored durably in Postgres.
					// Duplicating multi-megabyte Markdown/editor JSON in Redis makes a
					// single open evict useful cache entries and adds avoidable main-thread
					// JSON serialization pressure to the API process.
					shouldCache: (value) => {
						if (value.status === 404) return true;
						if (value.status !== 200) return false;
						if ("error" in value.body) return false;
						const jsonSize = value.body.contentJson
							? JSON.stringify(value.body.contentJson).length
							: 0;
						return (value.body.content?.length ?? 0) + jsonSize <= 512 * 1024;
					},
				},
			);
			set.status = response.status as 200 | 404;
			return response.body;
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
				if (hasPlacementInput) {
					await acquireTenantTopologyLock(tx, ctx);
				}
				const existingRows = await tx
					.select({
						id: documents.id,
						title: documents.title,
						content: documents.content,
						contentJson: documents.contentJson,
						folderId: documents.folderId,
						categoryId: documents.categoryId,
						contentHash: documents.contentHash,
						updatedAt: documents.updatedAt,
					})
					.from(documents)
					.where(
						and(
							eq(documents.id, params.id),
							tenantOwnerCondition(
								documents.ownerId,
								documents.workspaceId,
								ctx,
							),
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
					.for("update")
					.limit(1);
				if (existingRows.length === 0) {
					return null;
				}
				const existing = existingRows[0];
				if (!existing) return null;

				// Offline-first conflict detection. If the client supplies the
				// `updatedAt` it based its edit on, reject with 409 when the
				// server document has since changed. This lets the offline
				// mutation queue surface a conflict instead of silently
				// overwriting another writer's changes. The re-embed
				// invariant below is untouched for non-conflicting writes.
				const expectedUpdatedAt = body.data.expectedUpdatedAt;
				if (expectedUpdatedAt !== undefined && existing) {
					const currentUpdatedAt =
						existing.updatedAt instanceof Date
							? existing.updatedAt.toISOString()
							: String(existing.updatedAt);
					if (
						new Date(currentUpdatedAt).getTime() !==
						new Date(expectedUpdatedAt).getTime()
					) {
						return {
							error: "Document changed on the server",
							code: "DOCUMENT_CONFLICT",
							currentUpdatedAt,
							serverVersion: {
								id: existing.id,
								title: existing.title,
								content: existing.content,
								contentJson: existing.contentJson,
							},
							conflict: true as const,
						};
					}
				}

				if (hasPlacementInput) {
					let destinationCategory: string | null | undefined =
						body.data.categoryId !== undefined
							? body.data.categoryId
							: existing.categoryId;
					if (body.data.folderId) {
						destinationCategory = await resolveFolderEffectiveCategory(
							tx,
							ctx,
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
				const currentContentRevision =
					body.data.title !== undefined || body.data.content !== undefined
						? contentHash(
								body.data.title ?? existing.title,
								body.data.content ?? existing.content ?? "",
							)
						: undefined;

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
						...(currentContentRevision !== undefined && {
							contentHash: currentContentRevision,
						}),
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(documents.id, params.id),
							tenantOwnerCondition(
								documents.ownerId,
								documents.workspaceId,
								ctx,
							),
							isNull(documents.deletedAt),
						),
					)
					.returning();

				const folderChanged =
					body.data.folderId !== undefined &&
					body.data.folderId !== existing.folderId;
				const categoryChanged =
					body.data.categoryId !== undefined &&
					body.data.categoryId !== existing.categoryId;
				const impact =
					updated && (folderChanged || categoryChanged)
						? await snapshotDocumentMetadataImpact(tx, ctx, params.id)
						: undefined;

				return {
					updated,
					existing,
					folderChanged,
					categoryChanged,
					operationId: impact?.operationId,
				};
			});

			if (!result) {
				set.status = 404;
				return { error: "Document not found" };
			}
			if ("forbidden" in result) {
				set.status = 403;
				return { error: "Forbidden" };
			}
			if ("conflict" in result && result.conflict) {
				set.status = 409;
				return {
					error: result.error,
					code: result.code,
					currentUpdatedAt: result.currentUpdatedAt,
					serverVersion: result.serverVersion,
				};
			}
			const { updated, existing, folderChanged, categoryChanged, operationId } =
				result;

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
				if (folderChanged || categoryChanged) {
					dispatchMetadataReembedOutbox(
						operationId,
						metadataReembedPageSize("folder"),
					);
				} else {
					// Content edits retain the interactive Redis debounce contract. Metadata
					// placement changes use their transactionally committed outbox event.
					const revision = contentHash(
						updated?.title ?? existing?.title ?? "",
						updated?.content ?? existing?.content ?? "",
					);
					enqueueReembed([{ id: params.id, revision }], ctx.workspaceId, {
						reason: "content",
						refreshMode: "incremental",
					});
				}
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
			if (isAccountPurgeFencedError(err)) {
				set.status = 409;
				return accountPurgeFencedResponse();
			}
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
		let attachmentPlans: ReturnType<typeof planDuplicateAttachments> = [];
		const cleanupCopiedStorage = async (
			plans: ReturnType<typeof planDuplicateAttachments>,
		): Promise<void> => {
			await withTenant(ctx, async (tx) => {
				for (const plan of plans) {
					await activateAttachmentStorageCleanup(
						tx,
						"uncommitted_upload",
						plan.id,
					);
				}
			}).catch(() => undefined);
			for (const plan of plans) {
				await drainExactAttachmentStorageCleanup(
					"uncommitted_upload",
					plan.id,
				).catch(() => undefined);
			}
		};
		try {
			const sourceBundle = await withTenant(ctx, async (tx) => {
				await acquireTenantTopologyLock(tx, ctx);
				const sourceRows = await tx
					.select()
					.from(documents)
					.where(
						and(
							eq(documents.id, params.id),
							tenantOwnerCondition(
								documents.ownerId,
								documents.workspaceId,
								ctx,
							),
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
			attachmentPlans = planDuplicateAttachments(
				sourceBundle.sourceAttachments,
				userId,
				copyId,
				undefined,
				ctx.workspaceId,
			);
			const quotaAdmission = config.DOCSMINT_WORKSPACE_ENABLED
				? getDocsMintRuntimeOptions()?.attachmentStorageQuotaAdmission
				: null;
			if (
				config.DOCSMINT_WORKSPACE_ENABLED &&
				attachmentPlans.length > 0 &&
				!quotaAdmission
			) {
				set.status = 503;
				return { error: "Attachment storage quota admission is unavailable" };
			}
			const reservations: Array<{
				plan: (typeof attachmentPlans)[number];
				reservationId: string;
			}> = [];
			let copiedPlans: typeof attachmentPlans = [];
			const dropStagedIntents = async (): Promise<void> => {
				if (attachmentPlans.length === 0) return;
				await withTenant(ctx, (tx) =>
					tx.delete(attachmentStorageCleanupOutbox).where(
						and(
							eq(
								attachmentStorageCleanupOutbox.sourceKind,
								"uncommitted_upload",
							),
							inArray(
								attachmentStorageCleanupOutbox.sourceId,
								attachmentPlans.map((plan) => plan.id),
							),
						),
					),
				).catch(() => undefined);
			};
			try {
				if (attachmentPlans.length > 0) {
					await withTenant(ctx, async (tx) => {
						for (const plan of attachmentPlans) {
							await stageAttachmentStorageCleanup(tx, {
								sourceKind: "uncommitted_upload",
								sourceId: plan.id,
								storageKey: plan.storageKey,
								documentId: copyId,
								actorUserId: userId,
								ownerUserId: userId,
								requestedByUserId: userId,
								workspaceId: ctx.workspaceId ?? null,
								size: plan.size,
								quotaOperationKey: `attachment:${copyId}:${plan.storageKey}`,
								quotaReleaseKind:
									ctx.workspaceId && quotaAdmission
										? "reserve_pending"
										: "none",
								quotaReservationId: null,
								notBefore: storageWriteHoldNotBefore(),
							});
						}
					});
					if (quotaAdmission && ctx.workspaceId) {
						for (const plan of attachmentPlans) {
							const context = {
								workspaceId: ctx.workspaceId,
								actorUserId: userId,
								documentId: copyId,
								storageKey: plan.storageKey,
								proposedSize: plan.size,
								requestId: plan.id,
								idempotencyKey: `attachment:${copyId}:${plan.storageKey}`,
							};
							try {
								const reservation = await quotaAdmission.reserve(context);
								reservations.push({ plan, reservationId: reservation.id });
							} catch (error) {
								for (const held of reservations) {
									await quotaAdmission
										.releaseReservation(
											{
												workspaceId: ctx.workspaceId,
												actorUserId: userId,
												documentId: copyId,
												storageKey: held.plan.storageKey,
												proposedSize: held.plan.size,
												requestId: held.plan.id,
												idempotencyKey: `attachment:${copyId}:${held.plan.storageKey}`,
											},
											held.reservationId,
										)
										.catch(() => undefined);
								}
								await dropStagedIntents();
								set.status = isRetryableQuotaError(error) ? 503 : 413;
								return {
									error: isRetryableQuotaError(error)
										? "Storage quota admission is unavailable"
										: "Storage quota exceeded",
								};
							}
						}
						await withTenant(ctx, async (tx) => {
							for (const held of reservations) {
								await tx
									.update(attachmentStorageCleanupOutbox)
									.set({
										quotaReservationId: held.reservationId,
										quotaReleaseKind: "reservation",
									})
									.where(
										and(
											eq(
												attachmentStorageCleanupOutbox.sourceKind,
												"uncommitted_upload",
											),
											eq(attachmentStorageCleanupOutbox.sourceId, held.plan.id),
										),
									);
							}
						});
					}
				}
				for (const plan of attachmentPlans) {
					await storage.send(
						new CopyObjectCommand({
							Bucket: BUCKET,
							CopySource: encodeS3CopySource(BUCKET, plan.sourceStorageKey),
							Key: plan.storageKey,
						}),
					);
					copiedPlans = [...copiedPlans, plan];
				}
				if (quotaAdmission && ctx.workspaceId) {
					for (const held of reservations) {
						await quotaAdmission.finalize(
							{
								workspaceId: ctx.workspaceId,
								actorUserId: userId,
								documentId: copyId,
								storageKey: held.plan.storageKey,
								proposedSize: held.plan.size,
								requestId: held.plan.id,
								idempotencyKey: `attachment:${copyId}:${held.plan.storageKey}`,
							},
							{ reservationId: held.reservationId, actualSize: held.plan.size },
						);
						await withTenant(ctx, (tx) =>
							tx
								.update(attachmentStorageCleanupOutbox)
								.set({ quotaReleaseKind: "committed" })
								.where(
									and(
										eq(
											attachmentStorageCleanupOutbox.sourceKind,
											"uncommitted_upload",
										),
										eq(attachmentStorageCleanupOutbox.sourceId, held.plan.id),
									),
								),
						);
					}
				}
			} catch (error) {
				if (quotaAdmission && ctx.workspaceId) {
					for (const held of reservations) {
						await quotaAdmission
							.releaseReservation(
								{
									workspaceId: ctx.workspaceId,
									actorUserId: userId,
									documentId: copyId,
									storageKey: held.plan.storageKey,
									proposedSize: held.plan.size,
									requestId: held.plan.id,
									idempotencyKey: `attachment:${copyId}:${held.plan.storageKey}`,
								},
								held.reservationId,
							)
							.catch(() => undefined);
					}
				}
				if (copiedPlans.length > 0) await cleanupCopiedStorage(copiedPlans);
				else await dropStagedIntents();
				throw error;
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
				await acquireTenantTopologyLock(tx, ctx);
				const [currentPlacement] = await tx
					.select({
						folderId: documents.folderId,
						categoryId: documents.categoryId,
					})
					.from(documents)
					.where(
						and(
							eq(documents.id, params.id),
							tenantOwnerCondition(
								documents.ownerId,
								documents.workspaceId,
								ctx,
							),
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
				if (!currentPlacement) {
					return null;
				}
				const [row] = await tx
					.insert(documents)
					.values({
						id: copyId,
						ownerId: userId,
						workspaceId: ctx.workspaceId ?? null,
						folderId: currentPlacement.folderId,
						categoryId: currentPlacement.categoryId,
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
							workspaceId: ctx.workspaceId ?? null,
							uploadedBy: userId,
							filename: plan.filename,
							mimeType: plan.mimeType,
							size: plan.size,
							storageKey: plan.storageKey,
						})),
					);
					await tx.delete(attachmentStorageCleanupOutbox).where(
						and(
							eq(
								attachmentStorageCleanupOutbox.sourceKind,
								"uncommitted_upload",
							),
							inArray(
								attachmentStorageCleanupOutbox.sourceId,
								attachmentPlans.map((plan) => plan.id),
							),
						),
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
			if (!copy) {
				await cleanupCopiedStorage(attachmentPlans);
				set.status = 404;
				return { error: "Document not found" };
			}

			void enqueueDocumentPipeline({
				documentId: copy.id,
				ownerId: userId,
				workspaceId: ctx.workspaceId,
				revision: contentHash(copy.title, copy.content ?? ""),
				source: "interactive",
			}).catch((err) =>
				logger.warn({ err, documentId: copy.id }, "Pipeline enqueue failed"),
			);
			invalidateDocListCache(userId);
			set.status = 201;
			return copy;
		} catch (err) {
			await cleanupCopiedStorage(attachmentPlans);
			if (isAccountPurgeFencedError(err)) {
				set.status = 409;
				return accountPurgeFencedResponse();
			}
			logger.error({ err }, "Failed to duplicate document");
			set.status = 500;
			return { error: "Failed to duplicate document" };
		}
	})

	// GET /api/trash — list soft-deleted documents for the verified tenant.
	.get("/trash", async ({ request, set }) => {
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
		const rows = await withTenant(ctx, (tx) =>
			tx
				.select({
					id: documents.id,
					title: documents.title,
					deletedAt: documents.deletedAt,
				})
				.from(documents)
				.where(
					and(
						tenantOwnerCondition(documents.ownerId, documents.workspaceId, ctx),
						isNotNull(documents.deletedAt),
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
				.orderBy(desc(documents.deletedAt)),
		);
		return {
			documents: rows.map((row) => ({
				...row,
				purgeAfter: row.deletedAt
					? new Date(
							row.deletedAt.getTime() +
								config.DOCUMENT_TRASH_RETENTION_DAYS * 86_400_000,
						)
					: null,
			})),
			folders: [],
		};
	})
	.post("/trash/documents/:id/restore", async ({ params, request, set }) => {
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
		let restored: { id: string } | null;
		try {
			restored = await withTenant(ctx, async (tx) => {
				await acquireDocumentPipelineLock(tx, params.id);
				const result = await tx
					.update(documents)
					.set({ deletedAt: null, updatedAt: new Date() })
					.where(
						and(
							eq(documents.id, params.id),
							tenantOwnerCondition(
								documents.ownerId,
								documents.workspaceId,
								ctx,
							),
							isNotNull(documents.deletedAt),
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
					.returning({ id: documents.id });
				return result[0] ?? null;
			});
		} catch (err) {
			if (isAccountPurgeFencedError(err)) {
				set.status = 409;
				return accountPurgeFencedResponse();
			}
			throw err;
		}
		if (!restored) {
			set.status = 404;
			return { error: "Document not found" };
		}
		invalidateDocCache(params.id);
		invalidateDocListCache(ctx.userId);
		return { success: true };
	})
	.delete("/trash/documents/:id", async ({ params, request, set }) => {
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
		if (await isAccountPurgeFenced(ctx.userId)) {
			set.status = 409;
			return accountPurgeFencedResponse();
		}
		const authorizedCondition = and(
			eq(documents.id, params.id),
			tenantOwnerCondition(documents.ownerId, documents.workspaceId, ctx),
			isNotNull(documents.deletedAt),
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
		);
		try {
			// Non-locking scoped preflight masks foreign IDs before taking the
			// document pipeline advisory. The final transaction repeats this exact
			// authorization predicate after acquiring its serialization locks.
			const visible = await withTenant(ctx, async (tx) => {
				const [authorized] = await tx
					.select({ id: documents.id })
					.from(documents)
					.where(authorizedCondition)
					.limit(1);
				return authorized ?? null;
			});
			if (!visible) {
				set.status = 404;
				return { error: "Document not found" };
			}

			const stagedCleanup = await withTenant(ctx, async (tx) => {
				await acquireDocumentPipelineLock(tx, params.id);
				const [authorized] = await tx
					.select({
						id: documents.id,
						ownerId: documents.ownerId,
						workspaceId: documents.workspaceId,
					})
					.from(documents)
					.where(authorizedCondition)
					.limit(1)
					.for("update");
				if (!authorized) throw new DocumentPurgeNotFoundError();
				const confirmed = await tx
					.select({
						id: attachments.id,
						storageKey: attachments.storageKey,
						size: attachments.size,
						uploadedBy: attachments.uploadedBy,
						workspaceId: attachments.workspaceId,
					})
					.from(attachments)
					.where(eq(attachments.documentId, params.id));
				const pending = await tx
					.select({
						id: pendingAttachmentUploads.id,
						tokenHash: pendingAttachmentUploads.tokenHash,
						filename: pendingAttachmentUploads.filename,
						mimeType: pendingAttachmentUploads.mimeType,
						storageKey: pendingAttachmentUploads.storageKey,
						declaredSize: pendingAttachmentUploads.declaredSize,
						actorUserId: pendingAttachmentUploads.actorUserId,
						workspaceId: pendingAttachmentUploads.workspaceId,
						quotaReservationId: pendingAttachmentUploads.quotaReservationId,
						quotaOperationKey: pendingAttachmentUploads.quotaOperationKey,
						quotaState: pendingAttachmentUploads.quotaState,
						actualSize: pendingAttachmentUploads.actualSize,
						urlIssuedAt: pendingAttachmentUploads.urlIssuedAt,
						expiresAt: pendingAttachmentUploads.expiresAt,
						leaseOwner: pendingAttachmentUploads.leaseOwner,
					})
					.from(pendingAttachmentUploads)
					.where(eq(pendingAttachmentUploads.documentId, params.id));
				await acquireAccountPurgeFenceLocks(tx, [
					ctx.userId,
					...(authorized.workspaceId ? [] : [authorized.ownerId]),
					...confirmed.map((row) => row.uploadedBy),
					...pending.map((row) => row.actorUserId),
				]);
				for (const row of confirmed) {
					await stageAttachmentStorageCleanup(tx, {
						sourceKind: "attachment",
						sourceId: row.id,
						storageKey: row.storageKey,
						documentId: params.id,
						actorUserId: row.uploadedBy,
						ownerUserId: authorized.ownerId,
						requestedByUserId: ctx.userId,
						workspaceId: row.workspaceId,
						size: row.size,
						quotaOperationKey: `attachment:${params.id}:${row.storageKey}`,
						quotaReleaseKind: row.workspaceId ? "committed" : "none",
					});
				}
				for (const row of pending) {
					await stagePendingAttachmentCleanup(
						tx,
						{
							...row,
							documentId: params.id,
							ownerUserId: authorized.ownerId,
						} as PendingAttachmentUploadRow,
						ctx.userId,
					);
				}
				const result = await tx
					.delete(documents)
					.where(authorizedCondition)
					.returning({ id: documents.id });
				const removed = result[0];
				if (!removed) throw new DocumentPurgeNotFoundError();
				return {
					confirmedIds: confirmed.map((row) => row.id),
					pendingIds: pending.map((row) => row.id),
				};
			});
			for (const attachmentId of stagedCleanup.confirmedIds) {
				await drainExactAttachmentStorageCleanup(
					"attachment",
					attachmentId,
				).catch((error) => {
					logger.error(
						{ err: error, documentId: params.id, attachmentId },
						"Document purge attachment cleanup retained for recovery",
					);
				});
			}
			for (const pendingId of stagedCleanup.pendingIds) {
				await drainExactAttachmentStorageCleanup(
					"pending_upload",
					pendingId,
				).catch((error) => {
					logger.error(
						{ err: error, documentId: params.id, pendingId },
						"Document purge pending-upload cleanup retained for recovery",
					);
				});
			}
			invalidateDocCache(params.id);
			invalidateDocListCache(ctx.userId);
			return { success: true };
		} catch (error) {
			if (error instanceof DocumentPurgeNotFoundError) {
				set.status = 404;
				return { error: "Document not found" };
			}
			if (isAccountPurgeFencedError(error)) {
				set.status = 409;
				return accountPurgeFencedResponse();
			}
			logger.error(
				{ err: error, documentId: params.id },
				"Failed to purge document",
			);
			set.status = 500;
			return { error: "Failed to purge document" };
		}
	})

	// DELETE /api/documents/:id — move document to trash. Use the explicit
	// trash purge endpoint for irreversible deletion.
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
		if (await isAccountPurgeFenced(ctx.userId)) {
			set.status = 409;
			return accountPurgeFencedResponse();
		}
		const userId = ctx.userId;
		try {
			const deleted = await withTenant(ctx, async (tx) => {
				await acquireDocumentPipelineLock(tx, params.id);
				const existing = await tx
					.select({ id: documents.id })
					.from(documents)
					.where(
						and(
							eq(documents.id, params.id),
							tenantOwnerCondition(
								documents.ownerId,
								documents.workspaceId,
								ctx,
							),
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
					.limit(1)
					.for("update");
				if (existing.length === 0) {
					return false;
				}
				const result = await tx
					.update(documents)
					.set({ deletedAt: new Date(), updatedAt: new Date() })
					.where(
						and(
							eq(documents.id, params.id),
							tenantOwnerCondition(
								documents.ownerId,
								documents.workspaceId,
								ctx,
							),
							isNull(documents.deletedAt),
						),
					)
					.returning({ id: documents.id });
				return result.length === 1;
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
			if (isAccountPurgeFencedError(err)) {
				set.status = 409;
				return accountPurgeFencedResponse();
			}
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
		const _userId = ctx.userId;
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
							tenantOwnerCondition(
								documents.ownerId,
								documents.workspaceId,
								ctx,
							),
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
			let multipartFiles: File[] | null = null;
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
				multipartFiles = files;
			} else {
				set.status = 415;
				return {
					error:
						"Unsupported content type. Use application/json or multipart/form-data",
				};
			}

			if (items.length === 0 && multipartFiles === null) {
				set.status = 400;
				return { error: "No importable items supplied" };
			}

			type CreatedEntry = {
				item: ImportedItem;
				row: {
					id: string;
					title: string;
					revision: string;
					categoryId: string | null;
				};
			};

			const persistItem = (item: ImportedItem): Promise<CreatedEntry> =>
				withTenant(ctx, async (tx) => {
					if (folderId) {
						await acquireTenantTopologyLock(tx, ctx);
					}
					let categoryId: string | null = null;
					if (folderId) {
						const resolvedCategoryId = await resolveFolderEffectiveCategory(
							tx,
							ctx,
							folderId,
						);
						if (resolvedCategoryId === undefined) {
							throw new ImportInputError("Forbidden", 403);
						}
						categoryId = resolvedCategoryId;
					}
					if (!isAuthorizedCategory(access, categoryId)) {
						throw new ImportInputError("Forbidden", 403);
					}
					const revision = contentHash(item.title, item.content);
					const [row] = await tx
						.insert(documents)
						.values({
							ownerId: userId,
							title: item.title,
							content: item.content,
							contentHash: revision,
							folderId,
							categoryId,
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
					return {
						item,
						row: { ...row, revision, categoryId },
					};
				});

			const enqueueCreated = ({ row }: CreatedEntry): void => {
				void enqueueDocumentPipeline({
					documentId: row.id,
					ownerId: userId,
					workspaceId: ctx.workspaceId,
					revision: row.revision,
					source: "import",
				}).catch((err) =>
					logger.warn({ err, documentId: row.id }, "Pipeline enqueue failed"),
				);
			};

			const createdResult = ({ item, row }: CreatedEntry) => {
				const now = new Date().toISOString();
				return {
					filename: item.filename,
					status: "ok" as const,
					document: {
						id: row.id,
						title: row.title,
						content: item.content,
						folderId,
						categoryId: row.categoryId,
						createdAt: now,
						updatedAt: now,
					},
				};
			};

			if (multipartFiles !== null) {
				type FailedImportResult = {
					filename: string;
					status: "error";
					error: string;
					code?: "ACCOUNT_PURGE_FENCED";
					failureStatus: number;
				};
				type SettledImportResult =
					| ReturnType<typeof createdResult>
					| FailedImportResult;

				const processFile = async (
					file: File,
				): Promise<SettledImportResult> => {
					try {
						if (file.size > MAX_IMPORT_SIZE) {
							throw new ImportInputError(
								`File "${file.name}" too large. Maximum size: ${MAX_IMPORT_SIZE / 1024 / 1024}MB`,
								413,
							);
						}
						const ext = `.${file.name.split(".").pop()?.toLowerCase()}`;
						if (!ALLOWED_IMPORT_EXTENSIONS.includes(ext)) {
							throw new ImportInputError(
								`Invalid file type for "${file.name}". Allowed: ${ALLOWED_IMPORT_EXTENSIONS.join(", ")}`,
								415,
							);
						}
						const parsedItem = await importFileToItem(file);
						const created = await persistItem({
							filename: file.name,
							title: parsedItem.title,
							content: parsedItem.content,
						});
						enqueueCreated(created);
						return createdResult(created);
					} catch (err: unknown) {
						if (isAccountPurgeFencedError(err)) {
							return {
								filename: file.name,
								status: "error",
								error: accountPurgeFencedResponse().error,
								code: accountPurgeFencedResponse().code,
								failureStatus: 409,
							};
						}
						if (err instanceof ImportInputError) {
							return {
								filename: file.name,
								status: "error",
								error: err.message,
								failureStatus: err.status,
							};
						}
						if (err instanceof DocxParseError) {
							logger.warn(
								{
									requestId: importRequestId,
									filename: file.name,
									kind: "docx_parse",
									itemCount: importItemCount,
									sizeBucket: byteSizeBucket(file.size),
								},
								"DOCX parse failure during import",
							);
							return {
								filename: file.name,
								status: "error",
								error: err.message,
								failureStatus: 422,
							};
						}
						const telemetry = importErrorTelemetry(err);
						logger.error(
							{
								requestId: importRequestId,
								filename: file.name,
								kind: telemetry.kind,
								code: telemetry.code,
								itemCount: importItemCount,
								sizeBucket: byteSizeBucket(file.size),
							},
							"Failed to import document",
						);
						return {
							filename: file.name,
							status: "error",
							error:
								telemetry.code === "54000"
									? "Document text is too large for the search index. Remove embedded data images or split the document."
									: "Failed to import document",
							failureStatus: telemetry.code === "54000" ? 422 : 500,
						};
					}
				};

				const settled = new Array<SettledImportResult>(multipartFiles.length);
				let nextFileIndex = 0;
				const worker = async (): Promise<void> => {
					while (nextFileIndex < multipartFiles.length) {
						const index = nextFileIndex;
						nextFileIndex += 1;
						const file = multipartFiles[index];
						if (file) settled[index] = await processFile(file);
					}
				};
				const concurrency = Math.min(3, multipartFiles.length);
				await Promise.all(Array.from({ length: concurrency }, () => worker()));

				const imported = settled.filter(
					(result) => result.status === "ok",
				).length;
				const failed = settled.length - imported;
				if (imported > 0) {
					set.status = 201;
				} else if (settled.length === 1) {
					const onlyResult = settled[0];
					set.status =
						onlyResult?.status === "error" ? onlyResult.failureStatus : 500;
					return {
						error:
							onlyResult?.status === "error"
								? onlyResult.error
								: "Failed to import document",
						...(onlyResult?.status === "error" && onlyResult.code
							? { code: onlyResult.code }
							: {}),
					};
				} else {
					const failureStatuses = new Set(
						settled.flatMap((result) =>
							result.status === "error" ? [result.failureStatus] : [],
						),
					);
					set.status =
						failureStatuses.size === 1
							? (failureStatuses.values().next().value ?? 422)
							: 422;
				}
				const allPurgeFenced = settled.every(
					(result) =>
						result.status === "error" && result.code === "ACCOUNT_PURGE_FENCED",
				);
				return {
					...(allPurgeFenced ? { code: "ACCOUNT_PURGE_FENCED" as const } : {}),
					items: settled.map((result) => {
						if (result.status === "ok") return result;
						const { failureStatus: _, ...publicResult } = result;
						return publicResult;
					}),
					imported,
					failed,
				};
			}

			const created: CreatedEntry[] = [];
			for (const item of items) {
				created.push(await persistItem(item));
			}

			// Embedding enqueue happens AFTER the transaction commits so
			// embeddings never get computed for documents that were rolled
			// back. We deliberately don't await — embedding is a background
			// job and shouldn't block the import response.
			for (const entry of created) enqueueCreated(entry);

			set.status = 201;
			// The JSON path has one synthesized file result. Multipart imports
			// return earlier with independently settled per-file results.
			const results = created.map(createdResult);
			return {
				items: results,
				imported: results.length,
				failed: 0,
			};
		} catch (err: unknown) {
			if (isAccountPurgeFencedError(err)) {
				set.status = 409;
				return accountPurgeFencedResponse();
			}
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
