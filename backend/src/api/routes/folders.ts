import { documents, folders } from "@hiai-docs/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";
import { invalidateDocListCache } from "../../lib/doc-cache";
import { logger } from "../../lib/logger";
import { reembedDocsInFolder } from "../../lib/reembed";
import { withTenant } from "../../lib/with-tenant";
import { writeRateLimiter } from "../middleware/rate-limit";
import { buildTenantContext } from "../middleware/tenant";

const createFolderSchema = z.object({
	name: z.string().min(1).max(255),
	// Accept string, null, or undefined so the frontend can explicitly send
	// `parentId: null` for root-level folders (the previous `.optional()`
	// rejected `null` with a 400).
	parentId: z.string().uuid().nullish(),
});

const updateFolderSchema = z.object({
	name: z.string().min(1).max(255).optional(),
	parentId: z.string().uuid().nullable().optional(),
	categoryId: z.string().uuid().nullable().optional(),
	order: z.number().int().nonnegative().optional(),
});

export const folderRoutes = new Elysia({ prefix: "/api/folders" })
	.get("/:id", async ({ params, set, request }) => {
		const ctx = await buildTenantContext(request);
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		const userId = ctx.userId;
		try {
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
				const childDocs = await tx
					.select()
					.from(documents)
					.where(
						and(
							eq(documents.folderId, params.id),
							eq(documents.ownerId, userId),
						),
					)
					.orderBy(documents.updatedAt);
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
		const ctx = await buildTenantContext(request);
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		const userId = ctx.userId;
		try {
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
			return rows;
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
		const ctx = await buildTenantContext(request);
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		const userId = ctx.userId;
		const parsed = createFolderSchema.safeParse(await request.json());
		if (!parsed.success) {
			set.status = 400;
			return { error: "Invalid input", details: parsed.error.flatten() };
		}
		try {
			const created = await withTenant(ctx, async (tx) => {
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
				const [row] = await tx
					.insert(folders)
					.values({
						ownerId: userId,
						name: parsed.data.name,
						parentId: parsed.data.parentId ?? null,
					})
					.returning();
				return { row };
			});
			if ("notFound" in created) {
				set.status = 404;
				return { error: "Parent folder not found" };
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
		const ctx = await buildTenantContext(request);
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
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
			if ("parentMissing" in result) {
				set.status = 404;
				return { error: "Parent folder not found" };
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
		const ctx = await buildTenantContext(request);
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		const userId = ctx.userId;
		try {
			const deleted = await withTenant(ctx, async (tx) => {
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
