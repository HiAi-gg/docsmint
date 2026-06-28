import { documents, documentTags, tags } from "@hiai-docs/db/schema";
import { and, count, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";
import { getSessionUserId } from "../../lib/auth-helpers";
import { db } from "../../lib/db";
import { invalidateDocCache } from "../../lib/doc-cache";
import { enqueueEmbedding } from "../../lib/embedding-queue";
import { logger } from "../../lib/logger";
import { writeRateLimiter } from "../middleware/rate-limit";

const createTagSchema = z.object({
	name: z.string().min(1).max(100),
	color: z.string().max(20).optional(),
});

const updateTagSchema = z.object({
	name: z.string().min(1).max(100).optional(),
	color: z.string().max(20).optional(),
});

const addTagToDocSchema = z.object({
	tagId: z.string().uuid(),
});

export const tagRoutes = new Elysia({ prefix: "/api" })
	.get("/tags", async ({ set, request }) => {
		const userId = await getSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		try {
			const rows = await db
				.select({
					id: tags.id,
					name: tags.name,
					color: tags.color,
					createdAt: tags.createdAt,
					documentCount: count(documentTags.documentId),
				})
				.from(tags)
				.leftJoin(documentTags, eq(tags.id, documentTags.tagId))
				.where(eq(tags.ownerId, userId))
				.groupBy(tags.id, tags.name, tags.color, tags.createdAt)
				.orderBy(tags.name);
			return rows;
		} catch (err) {
			logger.error({ err }, "Failed to list tags");
			set.status = 500;
			return { error: "Failed to list tags" };
		}
	})
	.post("/tags", async ({ request, set }) => {
		const ip =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"unknown";
		const rl = await writeRateLimiter(ip, request);
		if (!rl.allowed) {
			set.status = 429;
			return { error: "Rate limited" };
		}
		const userId = await getSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		const body = createTagSchema.safeParse(await request.json());
		if (!body.success) {
			set.status = 400;
			return { error: "Invalid input", details: body.error.flatten() };
		}
		try {
			const existing = await db
				.select({ id: tags.id })
				.from(tags)
				.where(and(eq(tags.ownerId, userId), eq(tags.name, body.data.name)))
				.limit(1);
			if (existing.length > 0) {
				set.status = 409;
				return { error: "Tag with this name already exists" };
			}
			const [created] = await db
				.insert(tags)
				.values({
					ownerId: userId,
					name: body.data.name,
					color: body.data.color ?? null,
				})
				.returning();
			set.status = 201;
			return created;
		} catch (err) {
			logger.error({ err }, "Failed to create tag");
			set.status = 500;
			return { error: "Failed to create tag" };
		}
	})
	.patch("/tags/:id", async ({ params, request, set }) => {
		const ip =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"unknown";
		const rl = await writeRateLimiter(ip, request);
		if (!rl.allowed) {
			set.status = 429;
			return { error: "Rate limited" };
		}
		const userId = await getSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		const body = updateTagSchema.safeParse(await request.json());
		if (!body.success) {
			set.status = 400;
			return { error: "Invalid input", details: body.error.flatten() };
		}
		try {
			const [updated] = await db
				.update(tags)
				.set({
					...(body.data.name !== undefined && { name: body.data.name }),
					...(body.data.color !== undefined && { color: body.data.color }),
				})
				.where(and(eq(tags.id, params.id), eq(tags.ownerId, userId)))
				.returning();
			if (!updated) {
				set.status = 404;
				return { error: "Tag not found" };
			}
			return updated;
		} catch (err) {
			logger.error({ err }, "Failed to update tag");
			set.status = 500;
			return { error: "Failed to update tag" };
		}
	})
	.delete("/tags/:id", async ({ params, set, request }) => {
		const ip =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"unknown";
		const rl = await writeRateLimiter(ip, request);
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
			await db
				.delete(tags)
				.where(and(eq(tags.id, params.id), eq(tags.ownerId, userId)));
			return { success: true };
		} catch (err) {
			logger.error({ err }, "Failed to delete tag");
			set.status = 500;
			return { error: "Failed to delete tag" };
		}
	})
	.post("/documents/:id/tags", async ({ params, request, set }) => {
		const ip =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"unknown";
		const rl = await writeRateLimiter(ip, request);
		if (!rl.allowed) {
			set.status = 429;
			return { error: "Rate limited" };
		}
		const userId = await getSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		const body = addTagToDocSchema.safeParse(await request.json());
		if (!body.success) {
			set.status = 400;
			return { error: "Invalid input" };
		}
		try {
			const [doc] = await db
				.select({ id: documents.id })
				.from(documents)
				.where(and(eq(documents.id, params.id), eq(documents.ownerId, userId)))
				.limit(1);
			if (!doc) {
				set.status = 404;
				return { error: "Document not found" };
			}

			await db.insert(documentTags).values({
				documentId: params.id,
				tagId: body.data.tagId,
			});
			// Re-embed so the new tag name appears in the embedding preamble.
			enqueueEmbedding(params.id);
			invalidateDocCache(params.id);
			set.status = 201;
			return { success: true };
		} catch (err) {
			logger.error({ err }, "Failed to add tag to document");
			set.status = 500;
			return { error: "Failed to add tag to document" };
		}
	})
	.delete("/documents/:id/tags/:tagId", async ({ params, set, request }) => {
		const ip =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"unknown";
		const rl = await writeRateLimiter(ip, request);
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
			const [doc] = await db
				.select({ id: documents.id })
				.from(documents)
				.where(and(eq(documents.id, params.id), eq(documents.ownerId, userId)))
				.limit(1);
			if (!doc) {
				set.status = 404;
				return { error: "Document not found" };
			}

			await db
				.delete(documentTags)
				.where(
					and(
						eq(documentTags.documentId, params.id),
						eq(documentTags.tagId, params.tagId),
					),
				);
			// Re-embed so the removed tag is no longer in the preamble.
			enqueueEmbedding(params.id);
			invalidateDocCache(params.id);
			return { success: true };
		} catch (err) {
			logger.error({ err }, "Failed to remove tag from document");
			set.status = 500;
			return { error: "Failed to remove tag" };
		}
	});
