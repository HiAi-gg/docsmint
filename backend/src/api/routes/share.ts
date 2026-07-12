import {
	documents,
	folders,
	guestAccess,
	shareLinks,
} from "@hiai-docs/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { nanoid } from "nanoid";
import { z } from "zod";
import { recordAuditEvent } from "../../lib/audit";
import {
	canAccessContent,
	effectiveDocumentCategory,
	isAuthorizedCategory,
	resolveContentAccess,
	resolveFolderEffectiveCategory,
} from "../../lib/content-access";
import { logger } from "../../lib/logger";
import { redis } from "../../lib/redis";
import { withTenant } from "../../lib/with-tenant";
import {
	adminTenantContext,
	shareGuestTenantContext,
} from "../middleware/tenant";

async function authorizeShareLink(request: Request, shareId: string) {
	const access = await resolveContentAccess(request);
	if (access.ctx.role === "none" || !canAccessContent(access, "write")) {
		return { access, link: null, authorized: false as const };
	}
	const link = await withTenant(access.ctx, async (tx) => {
		const [row] = await tx
			.select({
				id: shareLinks.id,
				createdBy: shareLinks.createdBy,
				documentId: shareLinks.documentId,
				folderId: shareLinks.folderId,
				categoryId: documents.categoryId,
				documentFolderCategoryId: folders.categoryId,
			})
			.from(shareLinks)
			.leftJoin(documents, eq(documents.id, shareLinks.documentId))
			.leftJoin(folders, eq(folders.id, documents.folderId))
			.where(eq(shareLinks.id, shareId))
			.limit(1);
		if (!row) return null;
		const categoryId = row.documentId
			? effectiveDocumentCategory({
					categoryId: row.categoryId,
					folderCategoryId: row.documentFolderCategoryId,
				})
			: row.folderId
				? await resolveFolderEffectiveCategory(tx, access.userId, row.folderId)
				: null;
		return { ...row, effectiveCategoryId: categoryId ?? null };
	});
	return {
		access,
		link,
		authorized:
			!!link &&
			link.createdBy === access.userId &&
			isAuthorizedCategory(access, link.effectiveCategoryId),
	};
}

// ============================================
// Validation schemas
// ============================================

const createShareSchema = z
	.object({
		documentId: z.string().uuid().optional(),
		folderId: z.string().uuid().optional(),
		password: z.string().min(1).optional(),
		expiresIn: z.enum(["1h", "1d", "7d", "30d", "never"]).default("never"),
		role: z.enum(["viewer", "commenter", "editor"]).default("viewer"),
	})
	.refine((d) => d.documentId || d.folderId, {
		message: "Either documentId or folderId must be provided",
	});

const addGuestSchema = z.object({
	email: z.string().email("Invalid email address"),
});

const updateShareSchema = z.object({
	role: z.enum(["viewer", "commenter", "editor"]).optional(),
	expiresIn: z.enum(["1h", "1d", "7d", "30d", "never"]).optional(),
});

// ============================================
// Expiry calculation
// ============================================

function calculateExpiresAt(
	expiresIn: "1h" | "1d" | "7d" | "30d" | "never",
): Date | null {
	if (expiresIn === "never") return null;
	const ms: Record<string, number> = {
		"1h": 3_600_000,
		"1d": 86_400_000,
		"7d": 604_800_000,
		"30d": 2_592_000_000,
	};
	return new Date(Date.now() + (ms[expiresIn] ?? 0));
}

// ============================================
// Redis-based rate limiter for public access
// ============================================

const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_SEC = 60;

async function checkRateLimit(
	ip: string,
): Promise<{ allowed: boolean; retryAfter?: number }> {
	const key = `hiai-docs:ratelimit:${ip}`;
	try {
		// Atomic first-increment with TTL
		const first = await redis.set(key, 1, "EX", RATE_LIMIT_WINDOW_SEC, "NX");
		let current: number;
		if (first === "OK") {
			current = 1;
		} else {
			current = await redis.incr(key);
			// Ensure TTL is set if it somehow expired
			const ttl = await redis.ttl(key);
			if (ttl === -1) {
				await redis.expire(key, RATE_LIMIT_WINDOW_SEC);
			}
		}
		if (current > RATE_LIMIT_MAX) {
			const ttl = await redis.ttl(key);
			return {
				allowed: false,
				retryAfter: ttl > 0 ? ttl : RATE_LIMIT_WINDOW_SEC,
			};
		}
		return { allowed: true };
	} catch {
		// If Redis is down, deny the request (fail-closed)
		return { allowed: false, retryAfter: 60 };
	}
}

// ============================================
// Helper: get client IP
// ============================================

function getClientIp(request: Request): string {
	return (
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
		request.headers.get("x-real-ip") ??
		"unknown"
	);
}

// ============================================
// Routes
// ============================================

export const shareRoutes = new Elysia({ prefix: "/api/share" })

	// POST /api/share — Create share link (auth required)
	.post("/", async ({ request, set }) => {
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

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			set.status = 400;
			return { error: "Invalid JSON body" };
		}

		const parsed = createShareSchema.safeParse(body);
		if (!parsed.success) {
			set.status = 400;
			return {
				error: "Validation failed",
				details: parsed.error.flatten().fieldErrors,
			};
		}

		const { documentId, folderId, password, expiresIn, role } = parsed.data;

		// Verify ownership of the target document or folder
		const ownerCheck = await withTenant(ctx, async (tx) => {
			if (documentId) {
				const [doc] = await tx
					.select({
						id: documents.id,
						categoryId: documents.categoryId,
						folderCategoryId: folders.categoryId,
					})
					.from(documents)
					.leftJoin(folders, eq(folders.id, documents.folderId))
					.where(
						and(eq(documents.id, documentId), eq(documents.ownerId, userId)),
					)
					.limit(1);
				if (!doc) {
					return { notFound: "document" as const };
				}
				if (!isAuthorizedCategory(access, effectiveDocumentCategory(doc))) {
					return { forbidden: true as const };
				}
			}

			if (folderId) {
				const [folder] = await tx
					.select({ id: folders.id })
					.from(folders)
					.where(and(eq(folders.id, folderId), eq(folders.ownerId, userId)))
					.limit(1);
				if (!folder) {
					return { notFound: "folder" as const };
				}
				const categoryId = await resolveFolderEffectiveCategory(
					tx,
					userId,
					folderId,
				);
				if (!isAuthorizedCategory(access, categoryId ?? null)) {
					return { forbidden: true as const };
				}
			}
			return null;
		});
		if (ownerCheck?.notFound === "document") {
			set.status = 404;
			return { error: "Document not found" };
		}
		if (ownerCheck?.notFound === "folder") {
			set.status = 404;
			return { error: "Folder not found" };
		}
		if (ownerCheck && "forbidden" in ownerCheck) {
			set.status = 403;
			return { error: "Forbidden" };
		}

		const token = nanoid(21);
		const passwordHash = password ? await Bun.password.hash(password) : null;
		const expiresAt = calculateExpiresAt(expiresIn);

		const link = await withTenant(ctx, async (tx) => {
			const [row] = await tx
				.insert(shareLinks)
				.values({
					documentId: documentId ?? null,
					folderId: folderId ?? null,
					token,
					passwordHash,
					expiresAt,
					createdBy: userId,
					role,
				})
				.returning();
			return row ?? null;
		});

		if (!link) {
			set.status = 500;
			return { error: "Failed to create share link" };
		}

		logger.info(
			{ shareId: link.id, userId, documentId, folderId },
			"Share link created",
		);

		const ipAddress =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"";
		const userAgent = request.headers.get("user-agent") ?? "";
		recordAuditEvent({
			actorId: userId,
			action: "share.create",
			resourceType: "share",
			resourceId: link.id,
			details: { documentId, folderId, role },
			ipAddress,
			userAgent,
		}).catch(() => {});

		return {
			id: link.id,
			token: link.token,
			documentId: link.documentId,
			folderId: link.folderId,
			role: link.role,
			expiresAt: link.expiresAt?.toISOString() ?? null,
			hasPassword: !!link.passwordHash,
			createdAt: link.createdAt.toISOString(),
		};
	})

	// GET /api/share — List share links for current user (auth required)
	.get("/", async ({ request, set }) => {
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

		const links = await withTenant(ctx, async (tx) => {
			const rows = await tx
				.select({
					id: shareLinks.id,
					token: shareLinks.token,
					documentId: shareLinks.documentId,
					folderId: shareLinks.folderId,
					role: shareLinks.role,
					hasPassword: sql<boolean>`${shareLinks.passwordHash} IS NOT NULL`,
					expiresAt: shareLinks.expiresAt,
					createdAt: shareLinks.createdAt,
					documentTitle: documents.title,
					folderName: folders.name,
				})
				.from(shareLinks)
				.leftJoin(documents, eq(shareLinks.documentId, documents.id))
				.leftJoin(folders, eq(shareLinks.folderId, folders.id))
				.where(eq(shareLinks.createdBy, userId))
				.orderBy(shareLinks.createdAt);
			if (!access.restricted) return rows;
			const authorized = [];
			for (const row of rows) {
				let categoryId: string | null | undefined = null;
				if (row.documentId) {
					const [document] = await tx
						.select({
							categoryId: documents.categoryId,
							folderId: documents.folderId,
						})
						.from(documents)
						.where(eq(documents.id, row.documentId))
						.limit(1);
					categoryId =
						document?.categoryId ??
						(document?.folderId
							? await resolveFolderEffectiveCategory(
									tx,
									userId,
									document.folderId,
								)
							: null);
				} else if (row.folderId) {
					categoryId = await resolveFolderEffectiveCategory(
						tx,
						userId,
						row.folderId,
					);
				}
				if (isAuthorizedCategory(access, categoryId ?? null))
					authorized.push(row);
			}
			return authorized;
		});

		return {
			links: links.map((link) => ({
				id: link.id,
				token: link.token,
				documentId: link.documentId,
				folderId: link.folderId,
				role: link.role,
				hasPassword: link.hasPassword,
				expiresAt: link.expiresAt?.toISOString() ?? null,
				createdAt: link.createdAt.toISOString(),
				title: link.documentTitle ?? link.folderName ?? "Unknown",
				type: link.documentId ? ("document" as const) : ("folder" as const),
			})),
		};
	})

	// GET /api/share/:token — Access shared content (PUBLIC, no auth)
	.get("/:token", async ({ params, request, set }) => {
		const { token } = params;

		// Rate limit by IP
		const ip = getClientIp(request);
		const rl = await checkRateLimit(ip);
		if (!rl.allowed) {
			set.status = 429;
			return { error: "Too many requests", retryAfter: rl.retryAfter };
		}

		// Find share link by token. Public share lookup uses an admin
		// context so RLS lets us find the link by token alone; the token
		// itself is the authorization credential.
		const link = await withTenant(adminTenantContext(), async (tx) => {
			const [row] = await tx
				.select()
				.from(shareLinks)
				.where(eq(shareLinks.token, token))
				.limit(1);
			return row ?? null;
		});

		if (!link) {
			set.status = 404;
			return { error: "Share link not found" };
		}

		// Check if expired — return 410 Gone
		if (link.expiresAt && link.expiresAt < new Date()) {
			set.status = 410;
			return { error: "Share link has expired" };
		}

		// Check password if required
		if (link.passwordHash) {
			const password = request.headers.get("x-share-password");
			if (!password) {
				set.status = 401;
				return { error: "Password required", requiresPassword: true };
			}
			const valid = await Bun.password.verify(password, link.passwordHash);
			if (!valid) {
				set.status = 401;
				return { error: "Invalid password" };
			}
		}

		// Subsequent reads run with the link owner's identity so RLS
		// policies on documents / folders evaluate to the same scope the
		// owner would see.
		const ownerCtx = shareGuestTenantContext(link.createdBy);

		// Return document content
		if (link.documentId) {
			const documentId = link.documentId;
			const doc = await withTenant(ownerCtx, async (tx) => {
				const [row] = await tx
					.select({
						id: documents.id,
						title: documents.title,
						content: documents.content,
						contentJson: documents.contentJson,
						metadata: documents.metadata,
						createdAt: documents.createdAt,
						updatedAt: documents.updatedAt,
					})
					.from(documents)
					.where(eq(documents.id, documentId))
					.limit(1);
				return row ?? null;
			});

			if (!doc) {
				set.status = 404;
				return { error: "Shared document no longer exists" };
			}

			return {
				type: "document" as const,
				data: {
					id: doc.id,
					title: doc.title,
					content: doc.content,
					contentJson: doc.contentJson,
					metadata: doc.metadata,
					createdAt: doc.createdAt.toISOString(),
					updatedAt: doc.updatedAt.toISOString(),
				},
			};
		}

		// Return folder content
		if (link.folderId) {
			const folderId = link.folderId;
			const folder = await withTenant(ownerCtx, async (tx) => {
				const [row] = await tx
					.select({
						id: folders.id,
						name: folders.name,
						createdAt: folders.createdAt,
						updatedAt: folders.updatedAt,
					})
					.from(folders)
					.where(eq(folders.id, folderId))
					.limit(1);
				return row ?? null;
			});

			if (!folder) {
				set.status = 404;
				return { error: "Shared folder no longer exists" };
			}

			const childFolders = await withTenant(ownerCtx, async (tx) => {
				return tx
					.select({
						id: folders.id,
						name: folders.name,
						createdAt: folders.createdAt,
						updatedAt: folders.updatedAt,
					})
					.from(folders)
					.where(eq(folders.parentId, folderId))
					.orderBy(folders.name);
			});

			const folderDocs = await withTenant(ownerCtx, async (tx) => {
				return tx
					.select({
						id: documents.id,
						title: documents.title,
						createdAt: documents.createdAt,
						updatedAt: documents.updatedAt,
					})
					.from(documents)
					.where(eq(documents.folderId, folderId))
					.orderBy(documents.title);
			});

			return {
				type: "folder" as const,
				data: {
					id: folder.id,
					name: folder.name,
					createdAt: folder.createdAt.toISOString(),
					updatedAt: folder.updatedAt.toISOString(),
					folders: childFolders.map((f) => ({
						id: f.id,
						name: f.name,
						createdAt: f.createdAt.toISOString(),
						updatedAt: f.updatedAt.toISOString(),
					})),
					documents: folderDocs.map((doc) => ({
						id: doc.id,
						title: doc.title,
						createdAt: doc.createdAt.toISOString(),
						updatedAt: doc.updatedAt.toISOString(),
					})),
				},
			};
		}

		set.status = 500;
		return { error: "Share link has no associated content" };
	})

	// DELETE /api/share/:id — Revoke share link (auth required, owner only)
	.delete("/:id", async ({ params, request, set }) => {
		const authorization = await authorizeShareLink(request, params.id);
		const ctx = authorization.access.ctx;
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		if (!authorization.authorized) {
			set.status = authorization.link ? 403 : 404;
			return {
				error: authorization.link
					? "Forbidden: you can only revoke your own share links"
					: "Share link not found",
			};
		}
		const userId = ctx.userId;

		const { id } = params;

		const link = await withTenant(ctx, async (tx) => {
			const [row] = await tx
				.select({ id: shareLinks.id, createdBy: shareLinks.createdBy })
				.from(shareLinks)
				.where(eq(shareLinks.id, id))
				.limit(1);
			return row ?? null;
		});

		if (!link) {
			set.status = 404;
			return { error: "Share link not found" };
		}

		if (link.createdBy !== userId) {
			set.status = 403;
			return { error: "Forbidden: you can only revoke your own share links" };
		}

		// guest_access rows cascade via FK
		await withTenant(ctx, async (tx) => {
			await tx.delete(shareLinks).where(eq(shareLinks.id, id));
		});

		logger.info({ shareId: id, userId }, "Share link revoked");

		const ipAddress =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"";
		const userAgent = request.headers.get("user-agent") ?? "";
		recordAuditEvent({
			actorId: userId,
			action: "share.delete",
			resourceType: "share",
			resourceId: id,
			details: {},
			ipAddress,
			userAgent,
		}).catch(() => {});

		return { success: true };
	})

	// PATCH /api/share/:id — Update share link (role, expiresAt)
	.patch("/:id", async ({ params, request, set }) => {
		const authorization = await authorizeShareLink(request, params.id);
		const ctx = authorization.access.ctx;
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		if (!authorization.authorized) {
			set.status = authorization.link ? 403 : 404;
			return {
				error: authorization.link
					? "Forbidden: you can only update your own share links"
					: "Share link not found",
			};
		}
		const userId = ctx.userId;

		const { id } = params;

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			set.status = 400;
			return { error: "Invalid JSON body" };
		}

		const parsed = updateShareSchema.safeParse(body);
		if (!parsed.success) {
			set.status = 400;
			return {
				error: "Validation failed",
				details: parsed.error.flatten().fieldErrors,
			};
		}

		// Verify ownership
		const link = await withTenant(ctx, async (tx) => {
			const [row] = await tx
				.select({ id: shareLinks.id, createdBy: shareLinks.createdBy })
				.from(shareLinks)
				.where(eq(shareLinks.id, id))
				.limit(1);
			return row ?? null;
		});

		if (!link) {
			set.status = 404;
			return { error: "Share link not found" };
		}

		if (link.createdBy !== userId) {
			set.status = 403;
			return {
				error: "Forbidden: you can only update your own share links",
			};
		}

		const { role, expiresIn } = parsed.data;
		const expiresAt = expiresIn ? calculateExpiresAt(expiresIn) : undefined;

		const updated = await withTenant(ctx, async (tx) => {
			const [row] = await tx
				.update(shareLinks)
				.set({
					...(role !== undefined && { role }),
					...(expiresAt !== undefined && { expiresAt }),
				})
				.where(eq(shareLinks.id, id))
				.returning();
			return row ?? null;
		});

		if (!updated) {
			set.status = 500;
			return { error: "Failed to update share link" };
		}

		logger.info({ shareId: id, userId, role, expiresIn }, "Share link updated");

		return {
			id: updated.id,
			token: updated.token,
			documentId: updated.documentId,
			folderId: updated.folderId,
			role: updated.role,
			expiresAt: updated.expiresAt?.toISOString() ?? null,
			hasPassword: !!updated.passwordHash,
			createdAt: updated.createdAt.toISOString(),
		};
	})

	// POST /api/share/:id/guests — Add guest email access (auth required)
	.post("/:id/guests", async ({ params, request, set }) => {
		const authorization = await authorizeShareLink(request, params.id);
		const ctx = authorization.access.ctx;
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		if (!authorization.authorized) {
			set.status = authorization.link ? 403 : 404;
			return {
				error: authorization.link
					? "Forbidden: you can only add guests to your own share links"
					: "Share link not found",
			};
		}
		const userId = ctx.userId;

		const { id } = params;

		// Verify ownership
		const link = await withTenant(ctx, async (tx) => {
			const [row] = await tx
				.select({ id: shareLinks.id, createdBy: shareLinks.createdBy })
				.from(shareLinks)
				.where(eq(shareLinks.id, id))
				.limit(1);
			return row ?? null;
		});

		if (!link) {
			set.status = 404;
			return { error: "Share link not found" };
		}

		if (link.createdBy !== userId) {
			set.status = 403;
			return {
				error: "Forbidden: you can only add guests to your own share links",
			};
		}

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			set.status = 400;
			return { error: "Invalid JSON body" };
		}

		const parsed = addGuestSchema.safeParse(body);
		if (!parsed.success) {
			set.status = 400;
			return {
				error: "Validation failed",
				details: parsed.error.flatten().fieldErrors,
			};
		}

		const rows = await withTenant(ctx, async (tx) => {
			return tx
				.insert(guestAccess)
				.values({ shareLinkId: id, guestEmail: parsed.data.email })
				.onConflictDoNothing()
				.returning();
		});

		const guest = rows[0];
		if (!guest) {
			return { success: true, message: "Guest already has access" };
		}

		logger.info(
			{ shareId: id, guestEmail: parsed.data.email, userId },
			"Guest access granted",
		);

		return {
			success: true,
			guest: {
				id: guest.id,
				email: guest.guestEmail,
				grantedAt: guest.grantedAt.toISOString(),
			},
		};
	})

	// DELETE /api/share/:id/guests/:email — Remove guest access (auth required)
	.delete("/:id/guests/:email", async ({ params, request, set }) => {
		const authorization = await authorizeShareLink(request, params.id);
		const ctx = authorization.access.ctx;
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		if (!authorization.authorized) {
			set.status = authorization.link ? 403 : 404;
			return {
				error: authorization.link ? "Forbidden" : "Share link not found",
			};
		}
		const userId = ctx.userId;

		const { id, email } = params;

		// Verify ownership
		const link = await withTenant(ctx, async (tx) => {
			const [row] = await tx
				.select({ id: shareLinks.id, createdBy: shareLinks.createdBy })
				.from(shareLinks)
				.where(eq(shareLinks.id, id))
				.limit(1);
			return row ?? null;
		});

		if (!link) {
			set.status = 404;
			return { error: "Share link not found" };
		}

		if (link.createdBy !== userId) {
			set.status = 403;
			return {
				error: "Forbidden: you can only manage guests on your own share links",
			};
		}

		const deleted = await withTenant(ctx, async (tx) => {
			return tx
				.delete(guestAccess)
				.where(
					and(
						eq(guestAccess.shareLinkId, id),
						eq(guestAccess.guestEmail, email),
					),
				)
				.returning();
		});

		if (deleted.length === 0) {
			set.status = 404;
			return { error: "Guest not found" };
		}

		logger.info(
			{ shareId: id, guestEmail: email, userId },
			"Guest access revoked",
		);

		return { success: true };
	})

	// GET /api/share/:token/folders/:folderId — Get shared subfolder content
	.get("/:token/folders/:folderId", async ({ params, request, set }) => {
		const { token, folderId } = params;

		// 1. Authenticate share link
		const ip = getClientIp(request);
		const rl = await checkRateLimit(ip);
		if (!rl.allowed) {
			set.status = 429;
			return { error: "Too many requests", retryAfter: rl.retryAfter };
		}
		const link = await withTenant(adminTenantContext(), async (tx) => {
			const [row] = await tx
				.select()
				.from(shareLinks)
				.where(eq(shareLinks.token, token))
				.limit(1);
			return row ?? null;
		});
		if (!link) {
			set.status = 404;
			return { error: "Share link not found" };
		}
		if (link.expiresAt && link.expiresAt < new Date()) {
			set.status = 410;
			return { error: "Share link has expired" };
		}
		if (link.passwordHash) {
			const password = request.headers.get("x-share-password");
			if (!password) {
				set.status = 401;
				return { error: "Password required", requiresPassword: true };
			}
			const valid = await Bun.password.verify(password, link.passwordHash);
			if (!valid) {
				set.status = 401;
				return { error: "Invalid password" };
			}
		}

		// 2. Verify target folder is under the shared root folder
		if (!link.folderId) {
			set.status = 403;
			return { error: "Access denied" };
		}
		const ownerCtx = shareGuestTenantContext(link.createdBy);
		const isDescendant = await isFolderDescendant(
			ownerCtx,
			folderId,
			link.folderId,
		);
		if (!isDescendant) {
			set.status = 403;
			return { error: "Access denied" };
		}

		// 3. Fetch subfolder data
		const folder = await withTenant(ownerCtx, async (tx) => {
			const [row] = await tx
				.select({
					id: folders.id,
					name: folders.name,
					parentId: folders.parentId,
					createdAt: folders.createdAt,
					updatedAt: folders.updatedAt,
				})
				.from(folders)
				.where(eq(folders.id, folderId))
				.limit(1);
			return row ?? null;
		});
		if (!folder) {
			set.status = 404;
			return { error: "Folder not found" };
		}

		const childFolders = await withTenant(ownerCtx, async (tx) => {
			return tx
				.select({
					id: folders.id,
					name: folders.name,
					createdAt: folders.createdAt,
					updatedAt: folders.updatedAt,
				})
				.from(folders)
				.where(eq(folders.parentId, folderId))
				.orderBy(folders.name);
		});

		const folderDocs = await withTenant(ownerCtx, async (tx) => {
			return tx
				.select({
					id: documents.id,
					title: documents.title,
					createdAt: documents.createdAt,
					updatedAt: documents.updatedAt,
				})
				.from(documents)
				.where(eq(documents.folderId, folderId))
				.orderBy(documents.title);
		});

		return {
			id: folder.id,
			name: folder.name,
			parentId: folder.parentId,
			folders: childFolders.map((f) => ({
				id: f.id,
				name: f.name,
				createdAt: f.createdAt.toISOString(),
				updatedAt: f.updatedAt.toISOString(),
			})),
			documents: folderDocs.map((doc) => ({
				id: doc.id,
				title: doc.title,
				createdAt: doc.createdAt.toISOString(),
				updatedAt: doc.updatedAt.toISOString(),
			})),
		};
	})

	// GET /api/share/:token/documents/:docId — Get shared document content
	.get("/:token/documents/:docId", async ({ params, request, set }) => {
		const { token, docId } = params;

		// 1. Authenticate share link
		const ip = getClientIp(request);
		const rl = await checkRateLimit(ip);
		if (!rl.allowed) {
			set.status = 429;
			return { error: "Too many requests", retryAfter: rl.retryAfter };
		}
		const link = await withTenant(adminTenantContext(), async (tx) => {
			const [row] = await tx
				.select()
				.from(shareLinks)
				.where(eq(shareLinks.token, token))
				.limit(1);
			return row ?? null;
		});
		if (!link) {
			set.status = 404;
			return { error: "Share link not found" };
		}
		if (link.expiresAt && link.expiresAt < new Date()) {
			set.status = 410;
			return { error: "Share link has expired" };
		}
		if (link.passwordHash) {
			const password = request.headers.get("x-share-password");
			if (!password) {
				set.status = 401;
				return { error: "Password required", requiresPassword: true };
			}
			const valid = await Bun.password.verify(password, link.passwordHash);
			if (!valid) {
				set.status = 401;
				return { error: "Invalid password" };
			}
		}

		// 2. Verify target document is under the shared root folder or is the shared document
		const ownerCtx = shareGuestTenantContext(link.createdBy);
		let isAllowed = false;
		if (link.documentId === docId) {
			isAllowed = true;
		} else if (link.folderId) {
			isAllowed = await isDocumentDescendant(ownerCtx, docId, link.folderId);
		}
		if (!isAllowed) {
			set.status = 403;
			return { error: "Access denied" };
		}

		// 3. Fetch document data
		const doc = await withTenant(ownerCtx, async (tx) => {
			const [row] = await tx
				.select({
					id: documents.id,
					title: documents.title,
					content: documents.content,
					contentJson: documents.contentJson,
					metadata: documents.metadata,
					createdAt: documents.createdAt,
					updatedAt: documents.updatedAt,
				})
				.from(documents)
				.where(eq(documents.id, docId))
				.limit(1);
			return row ?? null;
		});

		if (!doc) {
			set.status = 404;
			return { error: "Document not found" };
		}

		return {
			id: doc.id,
			title: doc.title,
			content: doc.content,
			contentJson: doc.contentJson,
			metadata: doc.metadata,
			createdAt: doc.createdAt.toISOString(),
			updatedAt: doc.updatedAt.toISOString(),
		};
	});

async function isFolderDescendant(
	ctx: import("../../api/middleware/tenant").TenantContext,
	targetFolderId: string,
	rootFolderId: string,
): Promise<boolean> {
	if (targetFolderId === rootFolderId) return true;
	let currentId: string | null = targetFolderId;
	const visited = new Set<string>();
	while (currentId && currentId !== rootFolderId && !visited.has(currentId)) {
		visited.add(currentId);
		const lookupId: string = currentId;
		const row: { parentId: string | null } | null = await withTenant(
			ctx,
			async (tx) => {
				const [r] = await tx
					.select({ parentId: folders.parentId })
					.from(folders)
					.where(eq(folders.id, lookupId))
					.limit(1);
				return r ?? null;
			},
		);
		if (!row) return false;
		currentId = row.parentId;
	}
	return currentId === rootFolderId;
}

async function isDocumentDescendant(
	ctx: import("../../api/middleware/tenant").TenantContext,
	docId: string,
	rootFolderId: string,
): Promise<boolean> {
	const doc = await withTenant(ctx, async (tx) => {
		const [row] = await tx
			.select({ folderId: documents.folderId })
			.from(documents)
			.where(eq(documents.id, docId))
			.limit(1);
		return row ?? null;
	});
	if (!doc?.folderId) return false;
	return isFolderDescendant(ctx, doc.folderId, rootFolderId);
}
