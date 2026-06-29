import {
	documents,
	documentTags,
	folders,
	tags,
	versions,
} from "@hiai-docs/db/schema";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";
import { getSessionUserId } from "../../lib/auth-helpers";
import { contentHash } from "../../lib/content-hash";
import { db } from "../../lib/db";
import {
	cacheGetOrSet,
	docListKey,
	docSingleKey,
	invalidateDocCache,
	invalidateDocListCache,
} from "../../lib/doc-cache";
import { DocxParseError, docxToMarkdown } from "../../lib/docx-parser";
import { enqueueEmbedding } from "../../lib/embedding-queue";
import { logger } from "../../lib/logger";
import { enqueueReembed } from "../../lib/reembed";
import { maybePruneVersions } from "../../lib/version-prune";
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
});

const updateDocumentSchema = z.object({
	title: z.string().min(1).max(500).optional(),
	content: z.string().optional(),
	contentJson: z.unknown().optional(),
	metadata: z.unknown().optional(),
	folderId: z.string().uuid().nullable().optional(),
	categoryId: z.string().uuid().nullable().optional(),
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
		return {
			title: name.replace(/\.docx$/i, ""),
			content,
		};
	}
	if (name.toLowerCase().endsWith(".json")) {
		const text = await file.text();
		const jsonBody = JSON.parse(text);
		const jsonParsed = importJsonSchema.safeParse(jsonBody);
		if (!jsonParsed.success) {
			throw new Error(
				`Invalid JSON format in "${name}": ${JSON.stringify(jsonParsed.error.flatten())}`,
			);
		}
		return {
			title: jsonParsed.data.title ?? name.replace(/\.json$/i, ""),
			content: jsonParsed.data.content,
		};
	}
	const text = await file.text();
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
	rows: T[],
): Promise<
	Array<T & { tags: Array<{ id: string; name: string; color: string | null }> }>
> {
	if (rows.length === 0) return [];
	const ids = rows.map((r) => r.id);
	const tagRows = await db
		.select({
			documentId: documentTags.documentId,
			id: tags.id,
			name: tags.name,
			color: tags.color,
		})
		.from(documentTags)
		.innerJoin(tags, eq(tags.id, documentTags.tagId))
		.where(inArray(documentTags.documentId, ids));

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
	folderId: string,
	userId: string,
): Promise<string | null> {
	const rows = await db.execute(sql`
		WITH RECURSIVE ancestors AS (
			SELECT id, parent_id, category_id
			FROM folders
			WHERE id = ${folderId} AND owner_id = ${userId}
			UNION ALL
			SELECT f.id, f.parent_id, f.category_id
			FROM folders f
			JOIN ancestors a ON f.id = a.parent_id
			WHERE f.owner_id = ${userId}
		)
		SELECT category_id FROM ancestors
		WHERE category_id IS NOT NULL
		LIMIT 1
	`);
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

		const userId = await getSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		const parsed = listQuerySchema.safeParse(query);
		if (!parsed.success) {
			set.status = 400;
			return { error: "Invalid query", details: parsed.error.flatten() };
		}
		const { folderId, tag, page, limit } = parsed.data;
		const offset = (page - 1) * limit;
		const cacheKey = docListKey(userId, folderId, tag, page, limit);
		try {
			return await cacheGetOrSet(cacheKey, 30, async () => {
				const conditions = [eq(documents.ownerId, userId)];
				if (folderId) conditions.push(eq(documents.folderId, folderId));

				if (tag) {
					const [countResult, rows] = await Promise.all([
						db
							.select({ total: count() })
							.from(documents)
							.innerJoin(
								documentTags,
								eq(documents.id, documentTags.documentId),
							)
							.where(and(eq(documentTags.tagId, tag), ...conditions)),
						db
							.select({
								id: documents.id,
								title: documents.title,
								content: sql<string>`LEFT(${documents.content}, 200)`.as(
									"content",
								),
								folderId: documents.folderId,
								categoryId: documents.categoryId,
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
					return {
						items: await withTags(rows),
						total: countResult[0]?.total ?? 0,
						page,
						limit,
					};
				}

				const [countResult, rows] = await Promise.all([
					db
						.select({ total: count() })
						.from(documents)
						.where(and(...conditions)),
					db
						.select({
							id: documents.id,
							title: documents.title,
							content: sql<string>`LEFT(${documents.content}, 200)`.as(
								"content",
							),
							folderId: documents.folderId,
							categoryId: documents.categoryId,
							createdAt: documents.createdAt,
							updatedAt: documents.updatedAt,
						})
						.from(documents)
						.where(and(...conditions))
						.orderBy(desc(documents.updatedAt))
						.limit(limit)
						.offset(offset),
				]);
				return {
					items: await withTags(rows),
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

		const userId = await getSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Unauthorized" };
		}
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
			const initialDocJson = null;
			const folderId = body.data.folderId ?? null;
			let categoryId = body.data.categoryId ?? null;
			if (folderId && !categoryId) {
				categoryId = await resolveFolderCategory(folderId, userId);
			}

			const [created] = await db
				.insert(documents)
				.values({
					ownerId: userId,
					title: body.data.title,
					content: initialContent,
					contentJson: initialDocJson,
					folderId,
					categoryId,
				})
				.returning();
			if (!created) {
				set.status = 500;
				return { error: "Failed to create document" };
			}

			await db.insert(versions).values({
				documentId: created.id,
				content: initialContent,
				contentJson: null,
				createdBy: userId,
			});

			enqueueEmbedding(created.id);
			invalidateDocListCache(userId);
			set.status = 201;
			return created;
		} catch (err) {
			logger.error({ err }, "Failed to create document");
			set.status = 500;
			return { error: "Failed to create document" };
		}
	})

	// GET /api/documents/:id — Get document with tags
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

		const userId = await getSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		try {
			return await cacheGetOrSet(docSingleKey(params.id), 60, async () => {
				const rows = await db
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
						createdAt: documents.createdAt,
						updatedAt: documents.updatedAt,
					})
					.from(documents)
					.leftJoin(folders, eq(folders.id, documents.folderId))
					.where(
						and(eq(documents.id, params.id), eq(documents.ownerId, userId)),
					)
					.limit(1);

				const doc = rows[0];
				if (!doc) {
					set.status = 404;
					return { error: "Document not found" };
				}

				const docTags = await db
					.select({ id: tags.id, name: tags.name, color: tags.color })
					.from(tags)
					.innerJoin(documentTags, eq(tags.id, documentTags.tagId))
					.where(eq(documentTags.documentId, doc.id));

				return { ...doc, tags: docTags };
			});
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

		const userId = await getSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		const body = updateDocumentSchema.safeParse(await request.json());
		if (!body.success) {
			set.status = 400;
			return { error: "Invalid input", details: body.error.flatten() };
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
			const existing = await db
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
				.where(and(eq(documents.id, params.id), eq(documents.ownerId, userId)))
				.limit(1);
			if (existing.length === 0) {
				set.status = 404;
				return { error: "Document not found" };
			}

			await db.insert(versions).values({
				documentId: params.id,
				content: existing[0]?.content ?? "",
				contentJson: existing[0]?.contentJson,
				createdBy: userId,
			});

			// Fire-and-forget pruning. We don't await — pruning is a
			// background GC pass and must not block the user's PATCH
			// response. `maybePruneVersions` debounces itself via Redis
			// so rapid PATCHes (auto-save) won't trigger repeated scans.
			maybePruneVersions(params.id).catch((err: unknown) =>
				logger.error({ err, docId: params.id }, "Background prune failed"),
			);

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

			const [updated] = await db
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
					updatedAt: new Date(),
				})
				.where(and(eq(documents.id, params.id), eq(documents.ownerId, userId)))
				.returning();

			// Re-embed if either the content changed OR any metadata-bearing
			// field changed. The embedding preamble includes folder/category
			// names, so changing either invalidates the existing vectors even
			// when the content text is unchanged.
			const folderChanged =
				body.data.folderId !== undefined &&
				body.data.folderId !== existing[0]?.folderId;
			const categoryChanged =
				body.data.categoryId !== undefined &&
				body.data.categoryId !== existing[0]?.categoryId;

			let shouldReembed = folderChanged || categoryChanged;

			if (
				!shouldReembed &&
				(body.data.content !== undefined || body.data.title !== undefined)
			) {
				// Only re-embed if content actually changed (not an auto-save of same content)
				const titleToHash = body.data.title ?? existing[0]?.title ?? "";
				const contentToHash = body.data.content ?? existing[0]?.content ?? "";
				const newHash = contentHash(titleToHash, contentToHash);

				if (existing[0]?.contentHash !== newHash) {
					shouldReembed = true;
				}
			}

			if (shouldReembed) {
				// Use enqueueReembed for Redis SET-NX dedup so rapid PATCHes on the same doc
				// (auto-save) coalesce into a single worker tick. Direct enqueueEmbedding
				// would queue the same doc id once per PATCH.
				enqueueReembed([params.id]);
			}
			invalidateDocCache(params.id);
			invalidateDocListCache(userId);
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

		const userId = await getSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		try {
			const [source] = await db
				.select()
				.from(documents)
				.where(and(eq(documents.id, params.id), eq(documents.ownerId, userId)))
				.limit(1);
			if (!source) {
				set.status = 404;
				return { error: "Document not found" };
			}

			const [copy] = await db
				.insert(documents)
				.values({
					ownerId: userId,
					folderId: source.folderId,
					categoryId: source.categoryId,
					title: `${source.title} (Copy)`,
					content: source.content ?? "",
					contentJson: source.contentJson,
					metadata: source.metadata,
				})
				.returning();
			if (!copy) {
				set.status = 500;
				return { error: "Failed to duplicate document" };
			}

			await db.insert(versions).values({
				documentId: copy.id,
				content: copy.content ?? "",
				contentJson: copy.contentJson,
				createdBy: userId,
			});

			enqueueEmbedding(copy.id);
			invalidateDocListCache(userId);
			set.status = 201;
			return copy;
		} catch (err) {
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

		const userId = await getSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		try {
			const existing = await db
				.select({ id: documents.id })
				.from(documents)
				.where(and(eq(documents.id, params.id), eq(documents.ownerId, userId)))
				.limit(1);
			if (existing.length === 0) {
				set.status = 404;
				return { error: "Document not found" };
			}
			await db
				.delete(documents)
				.where(and(eq(documents.id, params.id), eq(documents.ownerId, userId)));
			invalidateDocCache(params.id);
			invalidateDocListCache(userId);
			return { success: true };
		} catch (err) {
			logger.error({ err }, "Failed to delete document");
			set.status = 500;
			return { error: "Failed to delete document" };
		}
	})

	.get("/documents/:id/export", async ({ params, set, request }) => {
		const userId = await getSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		try {
			const rows = await db
				.select({
					id: documents.id,
					title: documents.title,
					content: documents.content,
				})
				.from(documents)
				.where(and(eq(documents.id, params.id), eq(documents.ownerId, userId)))
				.limit(1);
			const doc = rows[0];
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

		const userId = await getSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		try {
			const contentType = request.headers.get("content-type") ?? "";

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
				const body = await request.json();
				const parsed = importJsonSchema.safeParse(body);
				if (!parsed.success) {
					set.status = 400;
					return {
						error: "Invalid import data",
						details: parsed.error.flatten(),
					};
				}
				const jsonTitle = parsed.data.title ?? "Imported Document";
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
				resolvedCategoryId = await resolveFolderCategory(folderId, userId);
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
				row: { id: string; title: string };
			};
			const created = await db.transaction(async (tx) => {
				const out: CreatedEntry[] = [];
				for (const item of items) {
					const [row] = await tx
						.insert(documents)
						.values({
							ownerId: userId,
							title: item.title,
							content: item.content,
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
					out.push({ item, row });
				}
				return out;
			});

			// Embedding enqueue happens AFTER the transaction commits so
			// embeddings never get computed for documents that were rolled
			// back. We deliberately don't await — embedding is a background
			// job and shouldn't block the import response.
			for (const { row } of created) {
				enqueueEmbedding(row.id);
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
			// DOCX parsing failures are user-actionable (bad file, encrypted
			// doc) so we surface them as 422 with a descriptive message
			// rather than collapsing them into a generic 500.
			if (err instanceof DocxParseError) {
				logger.warn(
					{ err, fileName: err.fileName },
					"DOCX parse failure during import",
				);
				set.status = 422;
				return { error: err.message };
			}
			logger.error({ err }, "Failed to import document");
			set.status = 500;
			return { error: "Failed to import document" };
		}
	});
