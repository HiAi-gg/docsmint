import { documents, folders } from "@hiai-docs/db/schema";
import { and, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { recordAuditEvent } from "../../lib/audit";
import {
	canAccessContent,
	effectiveDocumentCategory,
	isAuthorizedCategory,
	resolveContentAccess,
} from "../../lib/content-access";
import { withTenant } from "../../lib/with-tenant";
import { rateLimitHeaders, writeRateLimiter } from "../middleware/rate-limit";

export const visibilityRoutes = new Elysia({ prefix: "/api" })
	// POST /api/documents/:id/publish — set visibility to 'public'
	.post("/documents/:id/publish", async ({ params, set, request }) => {
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

		try {
			const result = await withTenant(ctx, async (tx) => {
				const [doc] = await tx
					.select({
						id: documents.id,
						ownerId: documents.ownerId,
						categoryId: documents.categoryId,
						folderCategoryId: folders.categoryId,
					})
					.from(documents)
					.leftJoin(folders, eq(folders.id, documents.folderId))
					.where(eq(documents.id, params.id))
					.limit(1);

				if (!doc) {
					return { notFound: true as const };
				}
				if (doc.ownerId !== userId) {
					return { forbidden: true as const };
				}
				if (!isAuthorizedCategory(access, effectiveDocumentCategory(doc))) {
					return { forbidden: true as const };
				}

				const [updated] = await tx
					.update(documents)
					.set({ visibility: "public" })
					.where(
						and(eq(documents.id, params.id), eq(documents.ownerId, userId)),
					)
					.returning();

				return { document: updated };
			});

			if (result.notFound) {
				set.status = 404;
				return { error: "Document not found" };
			}
			if (result.forbidden) {
				set.status = 403;
				return { error: "Forbidden" };
			}

			const ipAddress =
				request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
				request.headers.get("x-real-ip") ??
				"";
			const userAgent = request.headers.get("user-agent") ?? "";
			recordAuditEvent({
				actorId: userId,
				action: "document.publish",
				resourceType: "document",
				resourceId: params.id,
				details: {},
				ipAddress,
				userAgent,
			}).catch(() => {});

			return result.document;
		} catch {
			set.status = 500;
			return { error: "Failed to publish document" };
		}
	})

	// POST /api/documents/:id/unpublish — set visibility to 'private'
	.post("/documents/:id/unpublish", async ({ params, set, request }) => {
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

		try {
			const result = await withTenant(ctx, async (tx) => {
				const [doc] = await tx
					.select({
						id: documents.id,
						ownerId: documents.ownerId,
						categoryId: documents.categoryId,
						folderCategoryId: folders.categoryId,
					})
					.from(documents)
					.leftJoin(folders, eq(folders.id, documents.folderId))
					.where(eq(documents.id, params.id))
					.limit(1);

				if (!doc) {
					return { notFound: true as const };
				}
				if (doc.ownerId !== userId) {
					return { forbidden: true as const };
				}
				if (!isAuthorizedCategory(access, effectiveDocumentCategory(doc))) {
					return { forbidden: true as const };
				}

				const [updated] = await tx
					.update(documents)
					.set({ visibility: "private" })
					.where(
						and(eq(documents.id, params.id), eq(documents.ownerId, userId)),
					)
					.returning();

				return { document: updated };
			});

			if (result.notFound) {
				set.status = 404;
				return { error: "Document not found" };
			}
			if (result.forbidden) {
				set.status = 403;
				return { error: "Forbidden" };
			}

			const ipAddress =
				request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
				request.headers.get("x-real-ip") ??
				"";
			const userAgent = request.headers.get("user-agent") ?? "";
			recordAuditEvent({
				actorId: userId,
				action: "document.unpublish",
				resourceType: "document",
				resourceId: params.id,
				details: {},
				ipAddress,
				userAgent,
			}).catch(() => {});

			return result.document;
		} catch {
			set.status = 500;
			return { error: "Failed to unpublish document" };
		}
	});
