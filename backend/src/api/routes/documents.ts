import { documents, documentTags, tags, versions } from "@hiai-docs/db/schema";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";
import { getSessionUserId } from "../../lib/auth-helpers";
import { db } from "../../lib/db";
import { enqueueEmbedding } from "../../lib/embedding-queue";
import { logger } from "../../lib/logger";
import { markdownToDocJson } from "../../lib/markdown-to-doc";
import {
	documentRateLimiter,
	rateLimitHeaders,
	writeRateLimiter,
} from "../middleware/rate-limit";

const createDocumentSchema = z.object({
	title: z.string().min(1).max(500).default("Untitled"),
	content: z.string().optional(),
	folderId: z.string().uuid().optional(),
});

const updateDocumentSchema = z.object({
	title: z.string().min(1).max(500).optional(),
	content: z.string().optional(),
	contentJson: z.unknown().optional(),
	metadata: z.unknown().optional(),
	folderId: z.string().uuid().nullable().optional(),
});

const listQuerySchema = z.object({
	folderId: z.string().uuid().optional(),
	tag: z.string().uuid().optional(),
	page: z.coerce.number().int().min(1).default(1),
	limit: z.coerce.number().int().min(1).max(100).default(20),
});

const ALLOWED_IMPORT_EXTENSIONS = [".md", ".txt", ".markdown", ".json"];
const MAX_IMPORT_SIZE = 10 * 1024 * 1024;

const importJsonSchema = z.object({
	title: z.string().min(1).max(500).optional(),
	content: z.string().min(1).max(5_000_000),
	folderId: z.string().uuid().optional(),
});

/**
 * Attach a `tags` array (`{ id, name, color }`) to each document row in a
 * list response. Runs a single grouped query for all rows so the list
 * endpoint can show tags without an N+1 round trip.
 */
async function withTags<T extends { id: string }>(
	rows: T[],
): Promise<Array<T & { tags: Array<{ id: string; name: string; color: string | null }> }>> {
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

	const byDoc = new Map<string, Array<{ id: string; name: string; color: string | null }>>();
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
		const rl = await documentRateLimiter(ip);
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
		try {
			const conditions = [eq(documents.ownerId, userId)];
			if (folderId) conditions.push(eq(documents.folderId, folderId));

			if (tag) {
				const [countResult, rows] = await Promise.all([
					db
						.select({ total: count() })
						.from(documents)
						.innerJoin(documentTags, eq(documents.id, documentTags.documentId))
						.where(and(eq(documentTags.tagId, tag), ...conditions)),
					db
						.select({
							id: documents.id,
							title: documents.title,
							content: sql<string>`LEFT(${documents.content}, 200)`.as(
								"content",
							),
							folderId: documents.folderId,
							createdAt: documents.createdAt,
							updatedAt: documents.updatedAt,
						})
						.from(documents)
						.innerJoin(documentTags, eq(documents.id, documentTags.documentId))
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
						content: sql<string>`LEFT(${documents.content}, 200)`.as("content"),
						folderId: documents.folderId,
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
		const body = createDocumentSchema.safeParse(await request.json());
		if (!body.success) {
			set.status = 400;
			return { error: "Invalid input", details: body.error.flatten() };
		}
		try {
			// If the client posts raw markdown without the TipTap JSON view
			// (e.g. an import, a script, or any path that bypasses the
			// editor), generate the JSON server-side so the editor opens
			// with formatted content rather than the raw markdown source
			// the next time the document is opened. `markdownToDocJson`
			// returns `null` for empty input or on parse failure, in which
			// case we simply persist the markdown without a JSON view — the
			// frontend's `markdownToJson` helper will recover on load.
			const initialContent = body.data.content ?? "";
			const initialDocJson = initialContent
				? await markdownToDocJson(initialContent)
				: null;
			const [created] = await db
				.insert(documents)
				.values({
					ownerId: userId,
					title: body.data.title,
					content: initialContent,
					contentJson: initialDocJson,
					folderId: body.data.folderId ?? null,
				})
				.returning();
			if (!created) {
				set.status = 500;
				return { error: "Failed to create document" };
			}

			await db.insert(versions).values({
				documentId: created.id,
				content: initialContent,
				contentJson: initialDocJson,
				createdBy: userId,
			});

			enqueueEmbedding(created.id);
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
		const rl = await documentRateLimiter(ip);
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
			const rows = await db
				.select({
					id: documents.id,
					ownerId: documents.ownerId,
					folderId: documents.folderId,
					title: documents.title,
					content: documents.content,
					contentJson: documents.contentJson,
					metadata: documents.metadata,
					createdAt: documents.createdAt,
					updatedAt: documents.updatedAt,
				})
				.from(documents)
				.where(and(eq(documents.id, params.id), eq(documents.ownerId, userId)))
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
			body.data.folderId === undefined
		) {
			set.status = 400;
			return { error: "At least one field is required" };
		}
		try {
			const existing = await db
				.select({
					id: documents.id,
					content: documents.content,
					contentJson: documents.contentJson,
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

			// When the client sends new `content` but no `contentJson`,
			// generate the JSON view server-side so the editor can render
			// formatted content on the next open. When the client sends
			// both fields (the editor's normal save path), prefer the
			// client-supplied JSON — it reflects the user's live edits.
			let resolvedDocJson: unknown | undefined = body.data.contentJson;
			if (resolvedDocJson === undefined && body.data.content !== undefined) {
				resolvedDocJson = body.data.content
					? await markdownToDocJson(body.data.content)
					: null;
			}

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
					updatedAt: new Date(),
				})
				.where(and(eq(documents.id, params.id), eq(documents.ownerId, userId)))
				.returning();

			if (body.data.content !== undefined || body.data.title !== undefined) {
				enqueueEmbedding(params.id);
			}
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
		try {
			const contentType = request.headers.get("content-type") ?? "";
			let title: string;
			let content: string;
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
				title = parsed.data.title ?? "Imported Document";
				content = parsed.data.content;
				folderId = parsed.data.folderId ?? null;
			} else if (contentType.includes("multipart/form-data")) {
				const formData = await request.formData();
				const file = formData.get("file") as File | null;
				folderId = (formData.get("folderId") as string) ?? null;
				if (!file) {
					set.status = 400;
					return { error: "File is required" };
				}
				if (file.size > MAX_IMPORT_SIZE) {
					set.status = 413;
					return {
						error: `File too large. Maximum size: ${MAX_IMPORT_SIZE / 1024 / 1024}MB`,
					};
				}
				const ext = `.${file.name.split(".").pop()?.toLowerCase()}`;
				if (!ALLOWED_IMPORT_EXTENSIONS.includes(ext)) {
					set.status = 415;
					return {
						error: `Invalid file type. Allowed: ${ALLOWED_IMPORT_EXTENSIONS.join(", ")}`,
					};
				}
				if (folderId && !z.string().uuid().safeParse(folderId).success) {
					set.status = 400;
					return { error: "Invalid folderId" };
				}
				const text = await file.text();
				const name = file.name;
				if (name.endsWith(".json")) {
					const jsonBody = JSON.parse(text);
					const jsonParsed = importJsonSchema.safeParse(jsonBody);
					if (!jsonParsed.success) {
						set.status = 400;
						return {
							error: "Invalid JSON format",
							details: jsonParsed.error.flatten(),
						};
					}
					title = jsonParsed.data.title ?? name.replace(/\.json$/, "");
					content = jsonParsed.data.content;
				} else {
					title = name.replace(/\.(md|txt|markdown)$/, "");
					content = text;
				}
			} else {
				set.status = 415;
				return {
					error:
						"Unsupported content type. Use application/json or multipart/form-data",
				};
			}

			const [created] = await db
				.insert(documents)
				.values({
					ownerId: userId,
					title,
					content,
					folderId: folderId ?? null,
				})
				.returning();
			if (!created) {
				set.status = 500;
				return { error: "Failed to import document" };
			}

			await db.insert(versions).values({
				documentId: created.id,
				content,
				createdBy: userId,
			});

			enqueueEmbedding(created.id);
			set.status = 201;
			return created;
		} catch (err) {
			logger.error({ err }, "Failed to import document");
			set.status = 500;
			return { error: "Failed to import document" };
		}
	});
