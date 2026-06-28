import { categories, documents, folders } from "@hiai-docs/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";
import { getSessionUserId } from "../../lib/auth-helpers";
import { db } from "../../lib/db";
import { logger } from "../../lib/logger";
import { reembedDocsInCategory } from "../../lib/reembed";
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
});

export const updateCategorySchema = z.object({
	name: z.string().trim().min(1).max(255).optional(),
	order: z.number().int().nonnegative().optional(),
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

/**
 * Categories CRUD — all routes are user-scoped (`owner_id` enforced on every
 * query) and write routes are rate-limited via `writeRateLimiter`. The
 * folders/documents `category_id` FKs use `ON DELETE SET NULL`, so deleting a
 * category automatically detaches it from any folders or documents.
 */
export const categoryRoutes = new Elysia({ prefix: "/api" })
	.get("/categories", async ({ set, request }) => {
		const userId = await getSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		try {
			const rows = await db
				.select({
					id: categories.id,
					name: categories.name,
					order: categories.order,
					createdAt: categories.createdAt,
					updatedAt: categories.updatedAt,
					documentCount: sql<number>`(
						WITH RECURSIVE cat_folders AS (
							SELECT id FROM ${folders} WHERE category_id = "categories"."id" AND owner_id = ${userId}
							UNION ALL
							SELECT f.id FROM ${folders} f
							JOIN cat_folders cf ON f.parent_id = cf.id
						)
						SELECT COUNT(*)::int
						FROM ${documents}
						WHERE (
							${documents.categoryId} = "categories"."id"
							OR ${documents.folderId} IN (SELECT id FROM cat_folders)
						) AND ${documents.ownerId} = ${userId}
					)`,
					folderCount: sql<number>`(
						WITH RECURSIVE cat_folders AS (
							SELECT id FROM ${folders} WHERE category_id = "categories"."id" AND owner_id = ${userId}
							UNION ALL
							SELECT f.id FROM ${folders} f
							JOIN cat_folders cf ON f.parent_id = cf.id
						)
						SELECT COUNT(*)::int FROM cat_folders
					)`,
				})
				.from(categories)
				.where(eq(categories.ownerId, userId))
				.orderBy(categories.order, categories.name);
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
		const userId = await getSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		const parsed = createCategorySchema.safeParse(await request.json());
		if (!parsed.success) {
			set.status = 400;
			return { error: "Invalid input", details: parsed.error.flatten() };
		}
		try {
			const existing = await db
				.select({ id: categories.id })
				.from(categories)
				.where(
					and(
						eq(categories.ownerId, userId),
						eq(categories.name, parsed.data.name),
					),
				)
				.limit(1);
			if (existing.length > 0) {
				set.status = 409;
				return { error: "Category with this name already exists" };
			}
			const [created] = await db
				.insert(categories)
				.values({
					ownerId: userId,
					name: parsed.data.name,
				})
				.returning();
			set.status = 201;
			return created;
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
		const userId = await getSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		const parsed = updateCategorySchema.safeParse(await request.json());
		if (!parsed.success) {
			set.status = 400;
			return { error: "Invalid input", details: parsed.error.flatten() };
		}
		if (parsed.data.name === undefined && parsed.data.order === undefined) {
			set.status = 400;
			return { error: "At least one field (name or order) is required" };
		}
		const newName = parsed.data.name;
		try {
			if (newName !== undefined) {
				const existing = await db
					.select({ id: categories.id })
					.from(categories)
					.where(
						and(eq(categories.ownerId, userId), eq(categories.name, newName)),
					)
					.limit(1);
				if (existing.length > 0 && existing[0]?.id !== params.id) {
					set.status = 409;
					return { error: "Category with this name already exists" };
				}
			}
			const [updated] = await db
				.update(categories)
				.set({
					...(parsed.data.name !== undefined && { name: parsed.data.name }),
					...(parsed.data.order !== undefined && { order: parsed.data.order }),
					updatedAt: new Date(),
				})
				.where(
					and(eq(categories.id, params.id), eq(categories.ownerId, userId)),
				)
				.returning();
			if (!updated) {
				set.status = 404;
				return { error: "Category not found" };
			}

			// Re-embed every document whose category_id matches, plus every
			// document in a folder whose category_id matches. The category
			// name is part of the embedding preamble, so a rename leaves the
			// existing vectors stale until the worker refreshes them.
			if (parsed.data.name !== undefined) {
				reembedDocsInCategory(params.id, userId).catch((err: unknown) =>
					logger.warn(
						{ err, categoryId: params.id },
						"Failed to re-embed documents after category rename",
					),
				);
			}

			return updated;
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
		const userId = await getSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		try {
			const [deleted] = await db
				.delete(categories)
				.where(
					and(eq(categories.id, params.id), eq(categories.ownerId, userId)),
				)
				.returning({ id: categories.id });
			if (!deleted) {
				set.status = 404;
				return { error: "Category not found" };
			}
			// ON DELETE SET NULL on folders.category_id / documents.category_id
			// automatically detaches the category from any owned folders/docs.
			// We re-embed those docs/folders so their preamble no longer mentions
			// the (now-gone) category name.
			reembedDocsInCategory(params.id, userId).catch((err: unknown) =>
				logger.warn(
					{ err, categoryId: params.id },
					"Failed to re-embed documents after category delete",
				),
			);
			return { success: true };
		} catch (err) {
			logger.error({ err }, "Failed to delete category");
			set.status = 500;
			return { error: "Failed to delete category" };
		}
	});
