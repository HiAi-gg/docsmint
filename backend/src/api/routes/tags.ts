import { documents, documentTags, folders, tags } from "@hiai-docs/db/schema";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";
import {
	canAccessContent,
	effectiveDocumentCategoryCondition,
	resolveContentAccess,
	tenantOwnerCondition,
} from "../../lib/content-access";
import { invalidateDocCache } from "../../lib/doc-cache";
import { logger } from "../../lib/logger";
import {
	dispatchMetadataReembedOutbox,
	metadataReembedPageSize,
	snapshotDocumentMetadataImpact,
	snapshotTagMetadataImpact,
} from "../../lib/reembed";
import { acquireTenantTopologyLock } from "../../lib/topology-serialization";
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
			const rows = await withTenant(ctx, async (tx) => {
				if (!access.restricted) {
					return tx
						.select({
							id: tags.id,
							name: tags.name,
							color: tags.color,
							createdAt: tags.createdAt,
							documentCount: count(documents.id),
						})
						.from(tags)
						.leftJoin(documentTags, eq(tags.id, documentTags.tagId))
						.leftJoin(
							documents,
							and(
								eq(documents.id, documentTags.documentId),
								tenantOwnerCondition(
									documents.ownerId,
									documents.workspaceId,
									ctx,
								),
								isNull(documents.deletedAt),
							),
						)
						.where(tenantOwnerCondition(tags.ownerId, tags.workspaceId, ctx))
						.groupBy(tags.id, tags.name, tags.color, tags.createdAt)
						.orderBy(tags.name);
				}
				return tx
					.select({
						id: tags.id,
						name: tags.name,
						color: tags.color,
						createdAt: tags.createdAt,
						documentCount: count(documentTags.documentId),
					})
					.from(tags)
					.innerJoin(documentTags, eq(tags.id, documentTags.tagId))
					.innerJoin(documents, eq(documents.id, documentTags.documentId))
					.where(
						and(
							tenantOwnerCondition(tags.ownerId, tags.workspaceId, ctx),
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
					.where(
						and(
							tenantOwnerCondition(tags.ownerId, tags.workspaceId, ctx),
							eq(tags.name, body.data.name),
						),
					)
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
		const body = updateTagSchema.safeParse(await request.json());
		if (!body.success) {
			set.status = 400;
			return { error: "Invalid input", details: body.error.flatten() };
		}
		try {
			const updated = await withTenant(ctx, async (tx) => {
				await acquireTenantTopologyLock(tx, ctx);
				const [row] = await tx
					.update(tags)
					.set({
						...(body.data.name !== undefined && { name: body.data.name }),
						...(body.data.color !== undefined && { color: body.data.color }),
					})
					.where(
						and(
							eq(tags.id, params.id),
							tenantOwnerCondition(tags.ownerId, tags.workspaceId, ctx),
						),
					)
					.returning();
				if (!row) return null;
				const impact =
					body.data.name !== undefined
						? await snapshotTagMetadataImpact(tx, ctx, params.id)
						: undefined;
				return { row, operationId: impact?.operationId };
			});
			if (!updated) {
				set.status = 404;
				return { error: "Tag not found" };
			}

			// Re-embed every document linked to this tag if its name changed
			// (the tag name is part of the embedding preamble).
			if (body.data.name !== undefined) {
				dispatchMetadataReembedOutbox(
					updated.operationId,
					metadataReembedPageSize("tag"),
				);
			}

			return updated.row;
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
		try {
			const result = await withTenant(ctx, async (tx) => {
				const snapshot = await snapshotTagMetadataImpact(tx, ctx, params.id);

				await tx
					.delete(tags)
					.where(
						and(
							eq(tags.id, params.id),
							tenantOwnerCondition(tags.ownerId, tags.workspaceId, ctx),
						),
					);

				return snapshot;
			});

			dispatchMetadataReembedOutbox(
				result.operationId,
				metadataReembedPageSize("tag"),
			);

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
		const access = await resolveContentAccess(request);
		const ctx = access.ctx;
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		if (!canAccessContent(access, "edit")) {
			set.status = 403;
			return { error: "Forbidden" };
		}
		const body = addTagToDocSchema.safeParse(await request.json());
		if (!body.success) {
			set.status = 400;
			return { error: "Invalid input" };
		}
		try {
			const mutation = await withTenant(ctx, async (tx) => {
				await acquireTenantTopologyLock(tx, ctx);
				const [doc] = await tx
					.select({
						id: documents.id,
						title: documents.title,
						content: documents.content,
						categoryId: documents.categoryId,
						folderCategoryId: folders.categoryId,
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
				if (!doc) {
					return false;
				}

				await tx.insert(documentTags).values({
					documentId: params.id,
					tagId: body.data.tagId,
				});
				const impact = await snapshotDocumentMetadataImpact(tx, ctx, params.id);
				return { doc, operationId: impact.operationId };
			});
			if (!mutation) {
				set.status = 404;
				return { error: "Document not found" };
			}
			dispatchMetadataReembedOutbox(
				mutation.operationId,
				metadataReembedPageSize("tag"),
			);
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
		const access = await resolveContentAccess(request);
		const ctx = access.ctx;
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		if (!canAccessContent(access, "edit")) {
			set.status = 403;
			return { error: "Forbidden" };
		}
		try {
			const mutation = await withTenant(ctx, async (tx) => {
				await acquireTenantTopologyLock(tx, ctx);
				const [doc] = await tx
					.select({
						id: documents.id,
						title: documents.title,
						content: documents.content,
						categoryId: documents.categoryId,
						folderCategoryId: folders.categoryId,
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
				const impact = await snapshotDocumentMetadataImpact(tx, ctx, params.id);
				return { doc, operationId: impact.operationId };
			});
			if (!mutation) {
				set.status = 404;
				return { error: "Document not found" };
			}
			dispatchMetadataReembedOutbox(
				mutation.operationId,
				metadataReembedPageSize("tag"),
			);
			invalidateDocCache(params.id);
			return { success: true };
		} catch (err) {
			logger.error({ err }, "Failed to remove tag from document");
			set.status = 500;
			return { error: "Failed to remove tag" };
		}
	});
