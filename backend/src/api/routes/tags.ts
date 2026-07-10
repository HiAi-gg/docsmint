import { documents, documentTags, tags } from "@hiai-docs/db/schema";
import { and, count, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";
import { invalidateDocCache } from "../../lib/doc-cache";
import { logger } from "../../lib/logger";
import { enqueueReembed, reembedDocsByTag } from "../../lib/reembed";
import { withTenant } from "../../lib/with-tenant";
import { writeRateLimiter } from "../middleware/rate-limit";
import { buildTenantContext } from "../middleware/tenant";

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
		const ctx = await buildTenantContext(request);
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		const userId = ctx.userId;
		try {
			const rows = await withTenant(ctx, async (tx) => {
				return tx
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
			});
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
		const ctx = await buildTenantContext(request);
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		const userId = ctx.userId;
		const body = createTagSchema.safeParse(await request.json());
		if (!body.success) {
			set.status = 400;
			return { error: "Invalid input", details: body.error.flatten() };
		}
		try {
			const created = await withTenant(ctx, async (tx) => {
				const existing = await tx
					.select({ id: tags.id })
					.from(tags)
					.where(and(eq(tags.ownerId, userId), eq(tags.name, body.data.name)))
					.limit(1);
				if (existing.length > 0) {
					return { conflict: true as const };
				}
				const [row] = await tx
					.insert(tags)
					.values({
						ownerId: userId,
						name: body.data.name,
						color: body.data.color ?? null,
					})
					.returning();
				return { row };
			});
			if ("conflict" in created) {
				set.status = 409;
				return { error: "Tag with this name already exists" };
			}
			set.status = 201;
			return created.row;
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
		const ctx = await buildTenantContext(request);
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		const userId = ctx.userId;
		const body = updateTagSchema.safeParse(await request.json());
		if (!body.success) {
			set.status = 400;
			return { error: "Invalid input", details: body.error.flatten() };
		}
		try {
			const updated = await withTenant(ctx, async (tx) => {
				const [row] = await tx
					.update(tags)
					.set({
						...(body.data.name !== undefined && { name: body.data.name }),
						...(body.data.color !== undefined && { color: body.data.color }),
					})
					.where(and(eq(tags.id, params.id), eq(tags.ownerId, userId)))
					.returning();
				return row ?? null;
			});
			if (!updated) {
				set.status = 404;
				return { error: "Tag not found" };
			}

			// Re-embed every document linked to this tag if its name changed
			// (the tag name is part of the embedding preamble).
			if (body.data.name !== undefined) {
				reembedDocsByTag(params.id, userId).catch((err: unknown) =>
					logger.warn(
						{ err, tagId: params.id },
						"Failed to re-embed documents after tag rename",
					),
				);
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
		const ctx = await buildTenantContext(request);
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		const userId = ctx.userId;
		try {
			const result = await withTenant(ctx, async (tx) => {
				// Resolve affected doc ids BEFORE the tag is deleted. We re-embed
				// after a successful delete so the removed tag stops appearing in
				// the embedding preamble of every document it was on.
				const affectedDocs = await tx
					.select({ documentId: documentTags.documentId })
					.from(documentTags)
					.where(eq(documentTags.tagId, params.id));

				await tx
					.delete(tags)
					.where(and(eq(tags.id, params.id), eq(tags.ownerId, userId)));

				return { affectedDocs };
			});

			{
				const ids = Array.from(
					new Set(result.affectedDocs.map((r) => r.documentId)),
				);
				const enqueued = await enqueueReembed(ids);
				if (enqueued > 0) {
					logger.info(
						{ tagId: params.id, enqueued },
						"Tag deleted - re-embedding affected documents",
					);
				}
			}

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
		const ctx = await buildTenantContext(request);
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		const userId = ctx.userId;
		const body = addTagToDocSchema.safeParse(await request.json());
		if (!body.success) {
			set.status = 400;
			return { error: "Invalid input" };
		}
		try {
			const ok = await withTenant(ctx, async (tx) => {
				const [doc] = await tx
					.select({ id: documents.id })
					.from(documents)
					.where(
						and(eq(documents.id, params.id), eq(documents.ownerId, userId)),
					)
					.limit(1);
				if (!doc) {
					return false;
				}

				await tx.insert(documentTags).values({
					documentId: params.id,
					tagId: body.data.tagId,
				});
				return true;
			});
			if (!ok) {
				set.status = 404;
				return { error: "Document not found" };
			}
			// Re-embed so the new tag name appears in the embedding preamble.
			// enqueueReembed gives us per-doc Redis SET-NX dedup shared
			// with the rest of the metadata-driven re-embed triggers.
			enqueueReembed([params.id]);
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
		const ctx = await buildTenantContext(request);
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		const userId = ctx.userId;
		try {
			const ok = await withTenant(ctx, async (tx) => {
				const [doc] = await tx
					.select({ id: documents.id })
					.from(documents)
					.where(
						and(eq(documents.id, params.id), eq(documents.ownerId, userId)),
					)
					.limit(1);
				if (!doc) {
					return false;
				}

				await tx
					.delete(documentTags)
					.where(
						and(
							eq(documentTags.documentId, params.id),
							eq(documentTags.tagId, params.tagId),
						),
					);
				return true;
			});
			if (!ok) {
				set.status = 404;
				return { error: "Document not found" };
			}
			// Re-embed so the removed tag is no longer in the preamble.
			// enqueueReembed gives us per-doc Redis SET-NX dedup.
			enqueueReembed([params.id]);
			invalidateDocCache(params.id);
			return { success: true };
		} catch (err) {
			logger.error({ err }, "Failed to remove tag from document");
			set.status = 500;
			return { error: "Failed to remove tag" };
		}
	});
