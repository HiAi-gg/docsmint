import { categories, documents, folders } from "@hiai-docs/db/schema";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";
import {
	canAccessContent,
	canManageCategories,
	effectiveDocumentCategorySql,
	resolveContentAccess,
	tenantOwnerCondition,
	tenantOwnerSql,
} from "../../lib/content-access";
import { logger } from "../../lib/logger";
import {
	enqueueReembed,
	reembedDocsInCategory,
	snapshotMetadataImpact,
} from "../../lib/reembed";
import { withTenant } from "../../lib/with-tenant";
import { writeRateLimiter } from "../middleware/rate-limit";

/**
 * Zod schemas for categories.
 *
 * `name` is trimmed and bounded to 1..255 chars; both PATCH schemas make
 * every field optional so the client can update one without resending the
 * others. An empty PATCH body is rejected at the handler layer to avoid
 * no-op writes (matches `folders.ts` / `tags.ts`).
 */
export const createCategorySchema = z.object({
	name: z.string().trim().min(1).max(255),
	apiMode: z.enum(["unavailable", "global", "category"]).optional(),
	apiPermissionRead: z.boolean().optional(),
	apiPermissionEdit: z.boolean().optional(),
	apiPermissionWrite: z.boolean().optional(),
});

export const updateCategorySchema = z.object({
	name: z.string().trim().min(1).max(255).optional(),
	order: z.number().int().nonnegative().optional(),
	apiMode: z.enum(["unavailable", "global", "category"]).optional(),
	apiPermissionRead: z.boolean().optional(),
	apiPermissionEdit: z.boolean().optional(),
	apiPermissionWrite: z.boolean().optional(),
});

export const listQuerySchema = z.object({
	page: z.coerce.number().int().min(1).default(1),
	limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type ListCategoriesQuery = z.infer<typeof listQuerySchema>;

export const categorySchemas = {
	create: createCategorySchema,
	update: updateCategorySchema,
	list: listQuerySchema,
};

function normalizeApiMode(
	apiMode?: string | null,
): "unavailable" | "global" | "category" {
	if (apiMode === "category") return "category";
	if (apiMode === "global") return "global";
	return "unavailable";
}

function buildApiAccessValues(input: {
	apiMode?: string | null;
	apiPermissionRead?: boolean;
	apiPermissionEdit?: boolean;
	apiPermissionWrite?: boolean;
	existing?: {
		apiMode: string;
		apiPermissionRead: boolean;
		apiPermissionEdit: boolean;
		apiPermissionWrite: boolean;
	};
}) {
	const existing = input.existing ?? {
		apiMode: "unavailable",
		apiPermissionRead: false,
		apiPermissionEdit: false,
		apiPermissionWrite: false,
	};

	const apiMode =
		input.apiMode !== undefined
			? normalizeApiMode(input.apiMode)
			: normalizeApiMode(existing.apiMode);

	const apiPermissionRead =
		input.apiPermissionRead !== undefined
			? input.apiPermissionRead
			: existing.apiPermissionRead;
	const apiPermissionEdit =
		input.apiPermissionEdit !== undefined
			? input.apiPermissionEdit
			: existing.apiPermissionEdit;
	const apiPermissionWrite =
		input.apiPermissionWrite !== undefined
			? input.apiPermissionWrite
			: existing.apiPermissionWrite;

	if (apiMode === "unavailable") {
		return {
			apiMode,
			apiPermissionRead: false,
			apiPermissionEdit: false,
			apiPermissionWrite: false,
		};
	}

	return {
		apiMode,
		apiPermissionRead,
		apiPermissionEdit,
		apiPermissionWrite,
	};
}

/**
 * Categories CRUD — all routes are user-scoped (`owner_id` enforced on every
 * query) and write routes are rate-limited via `writeRateLimiter`. The
 * folders/documents `category_id` FKs use `ON DELETE SET NULL`, so deleting a
 * category automatically detaches it from any folders or documents.
 */
export const categoryRoutes = new Elysia({ prefix: "/api" })
	.get("/categories", async ({ set, request }) => {
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
			const rows = await withTenant(ctx, async (tx) => {
				const conditions = [
					tenantOwnerCondition(categories.ownerId, categories.workspaceId, ctx),
				];
				if (access.restricted) {
					if (!access.categoryId) return [];
					conditions.push(eq(categories.id, access.categoryId));
				}
				return tx
					.select({
						id: categories.id,
						name: categories.name,
						order: categories.order,
						apiMode: categories.apiMode,
						apiPermissionRead: categories.apiPermissionRead,
						apiPermissionEdit: categories.apiPermissionEdit,
						apiPermissionWrite: categories.apiPermissionWrite,
						createdAt: categories.createdAt,
						updatedAt: categories.updatedAt,
						documentCount: sql<number>`(
							WITH RECURSIVE cat_folders AS (
								SELECT id FROM ${folders} WHERE category_id = "categories"."id" AND ${tenantOwnerSql("folders", ctx)}
								UNION ALL
								SELECT f.id FROM ${folders} f
								JOIN cat_folders cf ON f.parent_id = cf.id
								WHERE ${tenantOwnerSql("f", ctx)}
							)
							SELECT COUNT(*)::int
							FROM ${documents}
							WHERE ${tenantOwnerSql("documents", ctx)}
								AND ${documents.deletedAt} IS NULL
								AND ${effectiveDocumentCategorySql("documents", ctx, sql.raw('"categories"."id"'))}
						)`,
						folderCount: sql<number>`(
							WITH RECURSIVE cat_folders AS (
								SELECT id FROM ${folders} WHERE category_id = "categories"."id" AND ${tenantOwnerSql("folders", ctx)}
								UNION ALL
								SELECT f.id FROM ${folders} f
								JOIN cat_folders cf ON f.parent_id = cf.id
								WHERE ${tenantOwnerSql("f", ctx)}
							)
							SELECT COUNT(*)::int FROM cat_folders
						)`,
					})
					.from(categories)
					.where(and(...conditions))
					.orderBy(categories.order, categories.name);
			});
			if (access.principal?.kind === "api-key") {
				return rows.map(
					({
						apiMode: _apiMode,
						apiPermissionRead: _apiPermissionRead,
						apiPermissionEdit: _apiPermissionEdit,
						apiPermissionWrite: _apiPermissionWrite,
						...metadata
					}) => metadata,
				);
			}
			return rows;
		} catch (err) {
			logger.error({ err }, "Failed to list categories");
			set.status = 500;
			return { error: "Failed to list categories" };
		}
	})
	.post("/categories", async ({ request, set }) => {
		const ip =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"unknown";
		const rl = await writeRateLimiter(ip);
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
		if (!canManageCategories(access)) {
			set.status = 403;
			return { error: "Full workspace write access required" };
		}
		const userId = ctx.userId;
		const parsed = createCategorySchema.safeParse(await request.json());
		if (!parsed.success) {
			set.status = 400;
			return { error: "Invalid input", details: parsed.error.flatten() };
		}
		try {
			const created = await withTenant(ctx, async (tx) => {
				const existing = await tx
					.select({ id: categories.id })
					.from(categories)
					.where(
						and(
							tenantOwnerCondition(
								categories.ownerId,
								categories.workspaceId,
								ctx,
							),
							eq(categories.name, parsed.data.name),
						),
					)
					.limit(1);
				if (existing.length > 0) {
					return { conflict: true as const };
				}
				const [row] = await tx
					.insert(categories)
					.values({
						ownerId: userId,
						name: parsed.data.name,
						...buildApiAccessValues({
							apiMode: parsed.data.apiMode,
							apiPermissionRead: parsed.data.apiPermissionRead,
							apiPermissionEdit: parsed.data.apiPermissionEdit,
							apiPermissionWrite: parsed.data.apiPermissionWrite,
						}),
					})
					.returning();
				return { row };
			});
			if ("conflict" in created) {
				set.status = 409;
				return { error: "Category with this name already exists" };
			}
			set.status = 201;
			return created.row;
		} catch (err) {
			logger.error({ err }, "Failed to create category");
			set.status = 500;
			return { error: "Failed to create category" };
		}
	})
	.patch("/categories/:id", async ({ params, request, set }) => {
		const ip =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"unknown";
		const rl = await writeRateLimiter(ip);
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
		if (!canManageCategories(access)) {
			set.status = 403;
			return { error: "Full workspace write access required" };
		}
		const userId = ctx.userId;
		const parsed = updateCategorySchema.safeParse(await request.json());
		if (!parsed.success) {
			set.status = 400;
			return { error: "Invalid input", details: parsed.error.flatten() };
		}
		if (
			parsed.data.name === undefined &&
			parsed.data.order === undefined &&
			parsed.data.apiMode === undefined &&
			parsed.data.apiPermissionRead === undefined &&
			parsed.data.apiPermissionEdit === undefined &&
			parsed.data.apiPermissionWrite === undefined
		) {
			set.status = 400;
			return {
				error:
					"At least one field (name, order, or API access setting) is required",
			};
		}
		const newName = parsed.data.name;
		const hasApiAccessUpdate =
			parsed.data.apiMode !== undefined ||
			parsed.data.apiPermissionRead !== undefined ||
			parsed.data.apiPermissionEdit !== undefined ||
			parsed.data.apiPermissionWrite !== undefined;
		try {
			const updated = await withTenant(ctx, async (tx) => {
				if (newName !== undefined) {
					const existing = await tx
						.select({ id: categories.id })
						.from(categories)
						.where(
							and(
								tenantOwnerCondition(
									categories.ownerId,
									categories.workspaceId,
									ctx,
								),
								eq(categories.name, newName),
							),
						)
						.limit(1);
					if (existing.length > 0 && existing[0]?.id !== params.id) {
						return { conflict: true as const };
					}
				}
				const [row] = await tx
					.update(categories)
					.set({
						...(parsed.data.name !== undefined && { name: parsed.data.name }),
						...(parsed.data.order !== undefined && {
							order: parsed.data.order,
						}),
						...(hasApiAccessUpdate
							? buildApiAccessValues({
									apiMode: parsed.data.apiMode,
									apiPermissionRead: parsed.data.apiPermissionRead,
									apiPermissionEdit: parsed.data.apiPermissionEdit,
									apiPermissionWrite: parsed.data.apiPermissionWrite,
								})
							: {}),
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(categories.id, params.id),
							tenantOwnerCondition(
								categories.ownerId,
								categories.workspaceId,
								ctx,
							),
						),
					)
					.returning();
				return { row: row ?? null };
			});
			if ("conflict" in updated) {
				set.status = 409;
				return { error: "Category with this name already exists" };
			}
			if (!updated.row) {
				set.status = 404;
				return { error: "Category not found" };
			}

			// Re-embed every document whose category_id matches, plus every
			// document in a folder whose category_id matches. The category
			// name is part of the embedding preamble, so a rename leaves the
			// existing vectors stale until the worker refreshes them.
			if (parsed.data.name !== undefined) {
				reembedDocsInCategory(params.id, userId, ctx.workspaceId).catch(
					(err: unknown) =>
						logger.warn(
							{ err, categoryId: params.id },
							"Failed to re-embed documents after category rename",
						),
				);
			}

			return updated.row;
		} catch (err) {
			logger.error({ err }, "Failed to update category");
			set.status = 500;
			return { error: "Failed to update category" };
		}
	})
	.delete("/categories/:id", async ({ params, set, request }) => {
		const ip =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"unknown";
		const rl = await writeRateLimiter(ip);
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
		if (!canManageCategories(access)) {
			set.status = 403;
			return { error: "Full workspace write access required" };
		}
		try {
			const deletion = await withTenant(ctx, async (tx) => {
				// Serialize FK attach checks with the folder/document snapshot. Without
				// this lock, READ COMMITTED permits a child to attach after the snapshot
				// and then be detached by ON DELETE SET NULL without a re-embed enqueue.
				const lockedCategory = await tx
					.select({ id: categories.id })
					.from(categories)
					.where(
						and(
							eq(categories.id, params.id),
							tenantOwnerCondition(
								categories.ownerId,
								categories.workspaceId,
								ctx,
							),
						),
					)
					.for("update")
					.limit(1);
				if (lockedCategory.length === 0) {
					return { deleted: null, affectedDocs: [] };
				}
				const impact = await snapshotMetadataImpact(
					tx,
					ctx,
					{ kind: "category", id: params.id },
					{ lockFolders: true },
				);
				const [row] = await tx
					.delete(categories)
					.where(
						and(
							eq(categories.id, params.id),
							tenantOwnerCondition(
								categories.ownerId,
								categories.workspaceId,
								ctx,
							),
						),
					)
					.returning({ id: categories.id });
				return { deleted: row ?? null, affectedDocs: impact.documents };
			});
			if (!deletion.deleted) {
				set.status = 404;
				return { error: "Category not found" };
			}
			// ON DELETE SET NULL on folders.category_id / documents.category_id
			// automatically detaches the category from any owned folders/docs.
			// We re-embed those docs/folders so their preamble no longer mentions
			// the (now-gone) category name.
			await enqueueReembed(
				deletion.affectedDocs,
				ctx.workspaceId,
				{ reason: "metadata", refreshMode: "full" },
			);
			return { success: true };
		} catch (err) {
			logger.error({ err }, "Failed to delete category");
			set.status = 500;
			return { error: "Failed to delete category" };
		}
	});
