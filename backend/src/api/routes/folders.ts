import { categories, documents, folders } from "@hiai-docs/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";
import {
	canAccessContent,
	isAuthorizedCategory,
	resolveContentAccess,
	resolveFolderEffectiveCategory,
} from "../../lib/content-access";
import { invalidateDocListCache } from "../../lib/doc-cache";
import { nextAvailableFolderName } from "../../lib/folder-name";
import { logger } from "../../lib/logger";
import { reembedDocsInFolder } from "../../lib/reembed";
import { withTenant } from "../../lib/with-tenant";
import { writeRateLimiter } from "../middleware/rate-limit";

const createFolderSchema = z.object({
	name: z.string().min(1).max(255),
	// Accept string, null, or undefined so the frontend can explicitly send
	// `parentId: null` for root-level folders (the previous `.optional()`
	// rejected `null` with a 400).
	parentId: z.string().uuid().nullish(),
	categoryId: z.string().uuid().nullish(),
});

const updateFolderSchema = z.object({
	name: z.string().min(1).max(255).optional(),
	parentId: z.string().uuid().nullable().optional(),
	categoryId: z.string().uuid().nullable().optional(),
	order: z.number().int().nonnegative().optional(),
});

export const folderRoutes = new Elysia({ prefix: "/api/folders" })
	.get("/:id", async ({ params, set, request }) => {
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
			if (access.restricted) {
				const effectiveCategory = await withTenant(ctx, (tx) =>
					resolveFolderEffectiveCategory(tx, userId, params.id),
				);
				if (!isAuthorizedCategory(access, effectiveCategory ?? null)) {
					set.status = 404;
					return { error: "Folder not found" };
				}
			}
			const result = await withTenant(ctx, async (tx) => {
				const [row] = await tx
					.select({
						id: folders.id,
						ownerId: folders.ownerId,
						parentId: folders.parentId,
						categoryId: folders.categoryId,
						name: folders.name,
						order: folders.order,
						createdAt: folders.createdAt,
						updatedAt: folders.updatedAt,
						documentCount: sql<number>`(
							WITH RECURSIVE sub_folders AS (
								SELECT id FROM folders f2 WHERE f2.id = "folders"."id" AND f2.owner_id = ${userId}
								UNION ALL
								SELECT f.id FROM folders f
								JOIN sub_folders sf ON f.parent_id = sf.id
							)
							SELECT COUNT(*)::int
							FROM documents d
							WHERE d.folder_id IN (SELECT id FROM sub_folders)
								AND d.owner_id = ${userId}
						)`,
						subfolderCount: sql<number>`(
							WITH RECURSIVE sub_folders AS (
								SELECT id FROM folders f2 WHERE f2.parent_id = "folders"."id" AND f2.owner_id = ${userId}
								UNION ALL
								SELECT f.id FROM folders f
								JOIN sub_folders sf ON f.parent_id = sf.id
							)
							SELECT COUNT(*)::int FROM sub_folders
						)`,
					})
					.from(folders)
					.where(and(eq(folders.id, params.id), eq(folders.ownerId, userId)))
					.limit(1);
				if (!row) {
					return null;
				}
				// Fetch child folders and documents
				const childFolders = await tx
					.select({
						id: folders.id,
						ownerId: folders.ownerId,
						parentId: folders.parentId,
						categoryId: folders.categoryId,
						name: folders.name,
						order: folders.order,
						createdAt: folders.createdAt,
						updatedAt: folders.updatedAt,
						documentCount: sql<number>`(
							WITH RECURSIVE sub_folders AS (
								SELECT id FROM folders f2 WHERE f2.id = "folders"."id" AND f2.owner_id = ${userId}
								UNION ALL
								SELECT f.id FROM folders f
								JOIN sub_folders sf ON f.parent_id = sf.id
							)
							SELECT COUNT(*)::int
							FROM documents d
							WHERE d.folder_id IN (SELECT id FROM sub_folders)
								AND d.owner_id = ${userId}
						)`,
						subfolderCount: sql<number>`(
							WITH RECURSIVE sub_folders AS (
								SELECT id FROM folders f2 WHERE f2.parent_id = "folders"."id" AND f2.owner_id = ${userId}
								UNION ALL
								SELECT f.id FROM folders f
								JOIN sub_folders sf ON f.parent_id = sf.id
							)
							SELECT COUNT(*)::int FROM sub_folders
						)`,
					})
					.from(folders)
					.where(
						and(eq(folders.parentId, params.id), eq(folders.ownerId, userId)),
					)
					.orderBy(folders.order, folders.name);
				const childDocRows = await tx
					.select({
						id: documents.id,
						title: documents.title,
						content: sql<string>`LEFT(${documents.content}, 200)`.as("content"),
						folderId: documents.folderId,
						categoryId: documents.categoryId,
						visibility: documents.visibility,
						createdAt: documents.createdAt,
						updatedAt: documents.updatedAt,
					})
					.from(documents)
					.where(
						and(
							eq(documents.folderId, params.id),
							eq(documents.ownerId, userId),
						),
					)
					.orderBy(documents.updatedAt);
				const childDocs = childDocRows.map((document) => ({
					...document,
					content: document.content?.slice(0, 200) ?? "",
				}));
				return { ...row, children: childFolders, documents: childDocs };
			});
			if (!result) {
				set.status = 404;
				return { error: "Folder not found" };
			}
			return result;
		} catch (err) {
			logger.error({ err }, "Failed to get folder");
			set.status = 500;
			return { error: "Failed to get folder" };
		}
	})
	.get("/", async ({ query, set, request }) => {
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
			if (access.restricted && query.parentId) {
				const parentId = query.parentId;
				const parentCategory = await withTenant(ctx, (tx) =>
					resolveFolderEffectiveCategory(tx, userId, parentId),
				);
				if (!isAuthorizedCategory(access, parentCategory ?? null)) {
					return [];
				}
			}
			const conditions = [eq(folders.ownerId, userId)];
			if (query.all === "true") {
				// Don't filter by parentId, get all folders flat!
			} else if (query.parentId) {
				conditions.push(eq(folders.parentId, query.parentId));
			} else {
				conditions.push(isNull(folders.parentId));
			}
			const rows = await withTenant(ctx, async (tx) => {
				return tx
					.select({
						id: folders.id,
						ownerId: folders.ownerId,
						parentId: folders.parentId,
						categoryId: folders.categoryId,
						name: folders.name,
						order: folders.order,
						createdAt: folders.createdAt,
						updatedAt: folders.updatedAt,
						documentCount: sql<number>`(
							WITH RECURSIVE sub_folders AS (
								SELECT id FROM folders f2 WHERE f2.id = "folders"."id" AND f2.owner_id = ${userId}
								UNION ALL
								SELECT f.id FROM folders f
								JOIN sub_folders sf ON f.parent_id = sf.id
							)
							SELECT COUNT(*)::int
							FROM documents d
							WHERE d.folder_id IN (SELECT id FROM sub_folders)
								AND d.owner_id = ${userId}
						)`,
						subfolderCount: sql<number>`(
							WITH RECURSIVE sub_folders AS (
								SELECT id FROM folders f2 WHERE f2.parent_id = "folders"."id" AND f2.owner_id = ${userId}
								UNION ALL
								SELECT f.id FROM folders f
								JOIN sub_folders sf ON f.parent_id = sf.id
							)
							SELECT COUNT(*)::int FROM sub_folders
						)`,
					})
					.from(folders)
					.where(and(...conditions))
					.orderBy(folders.order, folders.name);
			});
			if (!access.restricted || query.parentId) return rows;
			const byId = new Map(rows.map((row) => [row.id, row]));
			return rows.filter((row) => {
				let cursor: typeof row | undefined = row;
				const visited = new Set<string>();
				while (cursor && !visited.has(cursor.id)) {
					visited.add(cursor.id);
					if (cursor.categoryId) {
						return cursor.categoryId === access.categoryId;
					}
					cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
				}
				return false;
			});
		} catch (err) {
			logger.error({ err }, "Failed to list folders");
			set.status = 500;
			return { error: "Failed to list folders" };
		}
	})
	.post("/", async ({ request, set }) => {
		const ip =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"unknown";
		const rl = await writeRateLimiter(ip, request);
		if (!rl.allowed) {
			set.status = 429;
			return { error: "Rate limited" };
		}
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
		const parsed = createFolderSchema.safeParse(await request.json());
		if (!parsed.success) {
			set.status = 400;
			return { error: "Invalid input", details: parsed.error.flatten() };
		}
		try {
			const created = await withTenant(ctx, async (tx) => {
				const parentId = parsed.data.parentId ?? null;
				const categoryId = parentId ? null : (parsed.data.categoryId ?? null);
				const effectiveCategory = parentId
					? await resolveFolderEffectiveCategory(tx, userId, parentId)
					: categoryId;
				if (!isAuthorizedCategory(access, effectiveCategory ?? null)) {
					return { forbidden: true as const };
				}
				if (parsed.data.parentId) {
					const parent = await tx
						.select({ id: folders.id })
						.from(folders)
						.where(
							and(
								eq(folders.id, parsed.data.parentId),
								eq(folders.ownerId, userId),
							),
						)
						.limit(1);
					if (parent.length === 0) {
						return { notFound: true as const };
					}
				}
				if (categoryId) {
					const category = await tx
						.select({ id: categories.id })
						.from(categories)
						.where(
							and(
								eq(categories.id, categoryId),
								eq(categories.ownerId, userId),
							),
						)
						.limit(1);
					if (category.length === 0) {
						return { categoryNotFound: true as const };
					}
				}

				// Serialize allocation within this exact sibling scope. A database
				// uniqueness constraint is intentionally avoided because category deletion
				// uses ON DELETE SET NULL and folder moves remain independently editable.
				const scopeKey = parentId
					? `${userId}:parent:${parentId}`
					: `${userId}:category:${categoryId ?? "none"}`;
				await tx.execute(
					sql`SELECT pg_advisory_xact_lock(hashtextextended(${scopeKey}, 0))`,
				);
				const scopeConditions = [eq(folders.ownerId, userId)];
				if (parentId) {
					scopeConditions.push(eq(folders.parentId, parentId));
				} else {
					scopeConditions.push(isNull(folders.parentId));
					scopeConditions.push(
						categoryId
							? eq(folders.categoryId, categoryId)
							: isNull(folders.categoryId),
					);
				}
				const siblings = await tx
					.select({ name: folders.name })
					.from(folders)
					.where(and(...scopeConditions));
				const allocatedName = nextAvailableFolderName(
					parsed.data.name,
					siblings.map((s) => s.name),
				);
				const [row] = await tx
					.insert(folders)
					.values({
						ownerId: userId,
						name: allocatedName,
						parentId,
						categoryId,
					})
					.returning();
				return { row };
			});
			if ("notFound" in created) {
				set.status = 404;
				return { error: "Parent folder not found" };
			}
			if ("forbidden" in created) {
				set.status = 403;
				return { error: "Forbidden" };
			}
			if ("categoryNotFound" in created) {
				set.status = 404;
				return { error: "Category not found" };
			}
			set.status = 201;
			return created.row;
		} catch (err) {
			logger.error({ err }, "Failed to create folder");
			set.status = 500;
			return { error: "Failed to create folder" };
		}
	})
	.patch("/:id", async ({ params, request, set }) => {
		const ip =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"unknown";
		const rl = await writeRateLimiter(ip, request);
		if (!rl.allowed) {
			set.status = 429;
			return { error: "Rate limited" };
		}
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
		const parsed = updateFolderSchema.safeParse(await request.json());
		if (!parsed.success) {
			set.status = 400;
			return { error: "Invalid input", details: parsed.error.flatten() };
		}
		if (
			parsed.data.name === undefined &&
			parsed.data.parentId === undefined &&
			parsed.data.categoryId === undefined &&
			parsed.data.order === undefined
		) {
			set.status = 400;
			return {
				error:
					"At least one field (name, parentId, categoryId, or order) is required",
			};
		}
		try {
			const result = await withTenant(ctx, async (tx) => {
				const [current] = await tx
					.select({ id: folders.id })
					.from(folders)
					.where(and(eq(folders.id, params.id), eq(folders.ownerId, userId)))
					.limit(1);
				if (!current) {
					return { notFound: true as const };
				}
				const sourceCategory = await resolveFolderEffectiveCategory(
					tx,
					userId,
					params.id,
				);
				if (!isAuthorizedCategory(access, sourceCategory ?? null)) {
					return { forbidden: true as const };
				}
				if (
					parsed.data.parentId !== undefined ||
					parsed.data.categoryId !== undefined
				) {
					const destinationCategory = parsed.data.parentId
						? await resolveFolderEffectiveCategory(
								tx,
								userId,
								parsed.data.parentId,
							)
						: parsed.data.categoryId === undefined
							? sourceCategory
							: parsed.data.categoryId;
					if (!isAuthorizedCategory(access, destinationCategory ?? null)) {
						return { forbidden: true as const };
					}
				}
				if (parsed.data.parentId) {
					if (parsed.data.parentId === params.id) {
						return { selfParent: true as const };
					}
					const parent = await tx
						.select({ id: folders.id })
						.from(folders)
						.where(
							and(
								eq(folders.id, parsed.data.parentId),
								eq(folders.ownerId, userId),
							),
						)
						.limit(1);
					if (parent.length === 0) {
						return { parentMissing: true as const };
					}

					// Walk upward from the proposed parent. If the folder being moved
					// is encountered, the move would make it an ancestor of itself.
					const ownedFolders = await tx
						.select({ id: folders.id, parentId: folders.parentId })
						.from(folders)
						.where(eq(folders.ownerId, userId));
					const parentById = new Map(
						ownedFolders.map((folder) => [folder.id, folder.parentId]),
					);
					const visited = new Set<string>();
					let ancestorId: string | null = parsed.data.parentId;
					while (ancestorId && !visited.has(ancestorId)) {
						if (ancestorId === params.id) {
							return { cycle: true as const };
						}
						visited.add(ancestorId);
						ancestorId = parentById.get(ancestorId) ?? null;
					}
				}
				if (parsed.data.parentId === null && parsed.data.categoryId) {
					const [category] = await tx
						.select({ id: categories.id })
						.from(categories)
						.where(
							and(
								eq(categories.id, parsed.data.categoryId),
								eq(categories.ownerId, userId),
							),
						)
						.limit(1);
					if (!category) {
						return { categoryMissing: true as const };
					}
				}
				const [updated] = await tx
					.update(folders)
					.set({
						...(parsed.data.name !== undefined && { name: parsed.data.name }),
						...(parsed.data.parentId !== undefined && {
							parentId: parsed.data.parentId,
						}),
						...(parsed.data.categoryId !== undefined && {
							categoryId: parsed.data.categoryId,
						}),
						// If parentId is set (not null), categoryId MUST be null
						...(parsed.data.parentId ? { categoryId: null } : {}),
						...(parsed.data.order !== undefined && {
							order: parsed.data.order,
						}),
						updatedAt: new Date(),
					})
					.where(and(eq(folders.id, params.id), eq(folders.ownerId, userId)))
					.returning();
				if (!updated) {
					return { notFound: true as const };
				}
				return { updated };
			});
			if ("selfParent" in result) {
				set.status = 400;
				return { error: "Folder cannot be its own parent" };
			}
			if ("forbidden" in result) {
				set.status = 403;
				return { error: "Forbidden" };
			}
			if ("parentMissing" in result) {
				set.status = 404;
				return { error: "Parent folder not found" };
			}
			if ("cycle" in result) {
				set.status = 400;
				return { error: "Folder cannot be moved into its descendant" };
			}
			if ("categoryMissing" in result) {
				set.status = 404;
				return { error: "Category not found" };
			}
			if ("notFound" in result) {
				set.status = 404;
				return { error: "Folder not found" };
			}

			// When the folder name changes, every embedding that prepended
			// "Folder: <old-name>" to its chunk text becomes stale. Re-embed
			// the first batch of documents in this folder (max 100 per call)
			// to bound the cost spike from a rename. Subsequent batches can
			// be flushed by an explicit reindex job or a follow-up edit.
			if (parsed.data.name !== undefined) {
				reembedDocsInFolder(params.id, userId).catch((err: unknown) =>
					logger.warn(
						{ err, folderId: params.id },
						"Failed to enqueue re-embedding for folder rename",
					),
				);
				invalidateDocListCache(userId);
			}

			return result.updated;
		} catch (err) {
			logger.error({ err }, "Failed to update folder");
			set.status = 500;
			return { error: "Failed to update folder" };
		}
	})
	.delete("/:id", async ({ params, set, request }) => {
		const ip =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"unknown";
		const rl = await writeRateLimiter(ip, request);
		if (!rl.allowed) {
			set.status = 429;
			return { error: "Rate limited" };
		}
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
				const effectiveCategory = await resolveFolderEffectiveCategory(
					tx,
					userId,
					params.id,
				);
				if (!isAuthorizedCategory(access, effectiveCategory ?? null)) {
					return "forbidden" as const;
				}
				const existing = await tx
					.select({ id: folders.id })
					.from(folders)
					.where(and(eq(folders.id, params.id), eq(folders.ownerId, userId)))
					.limit(1);
				if (existing.length === 0) {
					return false;
				}
				await tx
					.delete(folders)
					.where(and(eq(folders.id, params.id), eq(folders.ownerId, userId)));
				return true;
			});
			if (deleted === "forbidden") {
				set.status = 403;
				return { error: "Forbidden" };
			}
			if (!deleted) {
				set.status = 404;
				return { error: "Folder not found" };
			}

			// FK ON DELETE SET NULL on documents.folder_id detaches the folder.
			// Re-embed affected docs so the "Folder: <old-name>" preamble
			// stops appearing in their embedding context.
			reembedDocsInFolder(params.id, userId).catch((err: unknown) =>
				logger.warn(
					{ err, folderId: params.id },
					"Failed to re-embed documents after folder delete",
				),
			);
			return { success: true };
		} catch (err) {
			logger.error({ err }, "Failed to delete folder");
			set.status = 500;
			return { error: "Failed to delete folder" };
		}
	});
