import { categories } from "@hiai-docs/db/schema";
import { and, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";
import {
	buildCategoryApiKeyScopes,
	createApiKey,
	GLOBAL_API_SCOPE,
	listApiKeys,
	revealCategoryApiKey,
	revokeApiKey,
} from "../../lib/api-keys";
import { recordAuditEvent } from "../../lib/audit";
import { resolveBrowserSessionUserId } from "../../lib/auth-principal";
import { config } from "../../lib/config";
import { logger } from "../../lib/logger";
import { withTenant } from "../../lib/with-tenant";
import { rateLimitHeaders, writeRateLimiter } from "../middleware/rate-limit";

const deleteKeySchema = z.object({});
const namedKeySchema = z.object({
	name: z.string().trim().min(1).max(255).optional(),
});

async function enforceKeyWriteRateLimit(request: Request) {
	const ip =
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
		request.headers.get("x-real-ip") ??
		"unknown";
	return writeRateLimiter(ip, request);
}

function auditKeyCreation(
	request: Request,
	actorId: string,
	resourceId: string,
	details: Record<string, unknown>,
) {
	recordAuditEvent({
		actorId,
		action: "api-key.create",
		resourceType: "api-key",
		resourceId,
		details,
		ipAddress:
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"",
		userAgent: request.headers.get("user-agent") ?? "",
	}).catch(() => {});
}

export const keysRoutes = new Elysia({ prefix: "/api" })
	.post("/keys/global", async ({ request, set }) => {
		const rl = await enforceKeyWriteRateLimit(request);
		if (!rl.allowed) {
			set.status = 429;
			set.headers = rateLimitHeaders(0, rl.retryAfter);
			return { error: "Too many requests" };
		}
		set.headers = rateLimitHeaders(rl.remaining);
		const userId = await resolveBrowserSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Browser session required" };
		}
		const parsed = namedKeySchema.safeParse(
			await request.json().catch(() => ({})),
		);
		if (!parsed.success) {
			set.status = 400;
			return { error: "Invalid input", details: parsed.error.flatten() };
		}
		const result = await createApiKey(
			userId,
			parsed.data.name ?? "Global API key",
			[GLOBAL_API_SCOPE],
		);
		auditKeyCreation(request, userId, result.id, { access: "global" });
		set.status = 201;
		return result;
	})
	.post("/categories/:id/keys", async ({ params, request, set }) => {
		const rl = await enforceKeyWriteRateLimit(request);
		if (!rl.allowed) {
			set.status = 429;
			set.headers = rateLimitHeaders(0, rl.retryAfter);
			return { error: "Too many requests" };
		}
		set.headers = rateLimitHeaders(rl.remaining);
		const userId = await resolveBrowserSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Browser session required" };
		}
		const ctx = { userId, role: "user" as const };
		const parsed = namedKeySchema.safeParse(
			await request.json().catch(() => ({})),
		);
		if (!parsed.success) {
			set.status = 400;
			return { error: "Invalid input", details: parsed.error.flatten() };
		}
		const [category] = await withTenant(ctx, (tx) =>
			tx
				.select({
					id: categories.id,
					name: categories.name,
					apiMode: categories.apiMode,
					read: categories.apiPermissionRead,
					edit: categories.apiPermissionEdit,
					write: categories.apiPermissionWrite,
				})
				.from(categories)
				.where(
					and(eq(categories.id, params.id), eq(categories.ownerId, ctx.userId)),
				)
				.limit(1),
		);
		if (!category) {
			set.status = 404;
			return { error: "Category not found" };
		}
		if (category.apiMode !== "category") {
			set.status = 409;
			return { error: "Save Category API access before issuing a scoped key" };
		}
		const scopes = buildCategoryApiKeyScopes(category.id, category);
		if (scopes.length === 0) {
			set.status = 409;
			return { error: "Category has no enabled API permissions" };
		}
		const result = await createApiKey(
			ctx.userId,
			parsed.data.name ?? `${category.name} API key`,
			scopes,
			undefined,
			{ encryptionSecret: config.API_KEY_ENCRYPTION_SECRET },
		);
		auditKeyCreation(request, ctx.userId, result.id, {
			access: "category",
			categoryId: category.id,
			scopes,
		});
		set.status = 201;
		return result;
	})
	.get("/keys/:id/secret", async ({ params, request, set }) => {
		const rl = await enforceKeyWriteRateLimit(request);
		if (!rl.allowed) {
			set.status = 429;
			set.headers = rateLimitHeaders(0, rl.retryAfter);
			return { error: "Too many requests" };
		}
		set.headers = {
			...rateLimitHeaders(rl.remaining),
			"cache-control": "no-store",
			pragma: "no-cache",
		};
		const userId = await resolveBrowserSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Browser session required" };
		}
		try {
			const key = await revealCategoryApiKey(
				params.id,
				userId,
				config.API_KEY_ENCRYPTION_SECRET,
			);
			if (!key) {
				set.status = 404;
				return { error: "Recoverable category API key not found" };
			}
			return { key };
		} catch (err) {
			logger.error(
				{ err, keyId: params.id },
				"Failed to reveal category API key",
			);
			set.status = 500;
			return { error: "Failed to reveal category API key" };
		}
	})
	// GET /api/keys — List user's API keys
	.get("/keys", async ({ request, set }) => {
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

		const userId = await resolveBrowserSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Browser session required" };
		}

		try {
			const keys = await listApiKeys(userId);
			return { keys };
		} catch (err) {
			logger.error({ err }, "Failed to list API keys");
			set.status = 500;
			return { error: "Failed to list API keys" };
		}
	})

	// DELETE /api/keys/:id — Revoke API key
	.delete("/keys/:id", async ({ params, request, set }) => {
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

		const userId = await resolveBrowserSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Browser session required" };
		}

		const parsed = deleteKeySchema.safeParse(params);
		if (!parsed.success) {
			set.status = 400;
			return { error: "Invalid key id" };
		}

		try {
			const deleted = await revokeApiKey(params.id, userId);
			if (!deleted) {
				set.status = 404;
				return { error: "API key not found" };
			}

			const ipAddress =
				request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
				request.headers.get("x-real-ip") ??
				"";
			const userAgent = request.headers.get("user-agent") ?? "";
			recordAuditEvent({
				actorId: userId,
				action: "api-key.revoke",
				resourceType: "api-key",
				resourceId: params.id,
				details: {},
				ipAddress,
				userAgent,
			}).catch(() => {});

			return { success: true };
		} catch (err) {
			logger.error({ err }, "Failed to revoke API key");
			set.status = 500;
			return { error: "Failed to revoke API key" };
		}
	});
