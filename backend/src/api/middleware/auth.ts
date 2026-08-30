import { documents, users } from "@hiai-docs/db/schema";
import { eq, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { validateApiKey } from "../../lib/api-keys";
import { auth } from "../../lib/auth";
import { config } from "../../lib/config";
import { type TenantContext, withTenant } from "../../lib/with-tenant";

/** Paths that are public — skip auth checks but still set RLS context. */
const PUBLIC_PATHS = ["/api/v1/public", "/api/v1/share"];

/** Shape of the session object returned by derive hooks in this module. */
type SessionDerived = {
	session: {
		session: {
			id: string;
			userId: string;
			expiresAt: Date;
			token: string;
			ipAddress?: string | null;
			userAgent?: string | null;
			createdAt: Date;
			updatedAt: Date;
		};
		user: {
			id: string;
			name: string | null;
			email: string;
			emailVerified: boolean;
			createdAt: Date;
			updatedAt: Date;
		};
	} | null;
};

function isPublicPath(path: string): boolean {
	return PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

function syntheticApiKeySession(
	ownerId: string,
): NonNullable<SessionDerived["session"]> {
	const now = new Date();
	return {
		session: {
			id: "api-key-session",
			userId: ownerId,
			expiresAt: new Date(now.getTime() + 60 * 60 * 24 * 365 * 10),
			token: "api-key",
			ipAddress: "",
			userAgent: "",
			createdAt: now,
			updatedAt: now,
		},
		user: {
			id: ownerId,
			name: "API Key User",
			email: `${ownerId}@hiai-docs.local`,
			emailVerified: true,
			createdAt: now,
			updatedAt: now,
		},
	};
}

async function resolveSession(request: Request): Promise<SessionDerived> {
	const authHeader = request.headers.get("authorization");
	if (authHeader?.startsWith("Bearer ")) {
		const token = authHeader.slice(7);
		if (config.HIAI_DOCS_API_KEY && token === config.HIAI_DOCS_API_KEY) {
			return { session: syntheticApiKeySession(config.OWNER_ID) };
		}

		try {
			const userKeyResult = await validateApiKey(token);
			if (userKeyResult) {
				return { session: syntheticApiKeySession(userKeyResult.ownerId) };
			}
		} catch {
			// A failed optional API-key lookup must retain the existing Better Auth fallback.
		}
	}

	return { session: await auth.api.getSession({ headers: request.headers }) };
}

export const authMiddleware = new Elysia()
	.derive(({ request }) => resolveSession(request))
	.macro({
		auth: {
			async resolve({ session, set }) {
				if (!session) {
					set.status = 401;
					return { error: "Unauthorized" };
				}
				return { user: session.user };
			},
		},
	});

/**
 * Guard plugin that requires an authenticated session.
 * Returns 401 if session.user is missing.
 * Embeds its own derive so it can work standalone without authMiddleware.
 *
 * @example
 * app.guard({}, requireUser(), (app) => app.get("/me", ...))
 */
export function requireUser() {
	return new Elysia()
		.derive(({ request }) => resolveSession(request))
		.guard({
			beforeHandle: async (ctx) => {
				const { session, set, path } = ctx as typeof ctx & SessionDerived;
				if (isPublicPath(path)) return;
				if (!session?.user) {
					set.status = 401;
					return { error: "Unauthorized" };
				}
			},
		});
}

/**
 * Guard factory that requires the authenticated user to have tier_level >= minLevel.
 * Returns 403 if the user's tier is insufficient.
 * Embeds its own derive so it can work standalone without authMiddleware.
 *
 * @param minLevel - Minimum tier level required (e.g. 1 = Basic, 2 = Pro, 3 = Enterprise)
 *
 * @example
 * app.guard({}, requireTier(2), (app) => app.get("/admin", ...))
 */
export function requireTier(minLevel: number) {
	return new Elysia()
		.derive(({ request }) => resolveSession(request))
		.guard({
			beforeHandle: async (ctx) => {
				const { session, set, path } = ctx as typeof ctx & SessionDerived;
				if (isPublicPath(path)) return;
				if (!session?.user) {
					set.status = 401;
					return { error: "Unauthorized" };
				}

				const userId = session.user.id;
				const tenantCtx: TenantContext = {
					userId,
					role: "user",
				};

				const [row] = await withTenant(tenantCtx, async (tx) =>
					tx
						.select({ tierLevel: sql<number>`tier_level` })
						.from(users)
						.where(eq(users.id, userId))
						.limit(1),
				);

				if (!row || (row.tierLevel ?? 0) < minLevel) {
					set.status = 403;
					return { error: "Insufficient tier level" };
				}
			},
		});
}

/**
 * Guard factory that requires the authenticated user to own the specified document.
 * Returns 403 if the user does not own the document.
 * Embeds its own derive so it can work standalone without authMiddleware.
 *
 * @param resourceId - Document ID to check ownership for. Can be a static string
 *                     or a function that extracts the ID from the Elysia context.
 *
 * @example
 * // Static resource ID
 * app.guard({}, requireOwner("doc-123"), (app) => app.delete("/docs/:id", ...))
 *
 * // Dynamic resource ID from route params
 * app.guard({}, requireOwner((ctx) => ctx.params.id), (app) => app.delete("/docs/:id", ...))
 */
export function requireOwner(
	resourceId: string | ((ctx: { params: Record<string, string> }) => string),
) {
	return new Elysia()
		.derive(({ request }) => resolveSession(request))
		.guard({
			beforeHandle: async (ctx) => {
				const { session, set, path, params } = ctx as typeof ctx &
					SessionDerived & { params: Record<string, string> };
				if (isPublicPath(path)) return;
				if (!session?.user) {
					set.status = 401;
					return { error: "Unauthorized" };
				}

				const docId =
					typeof resourceId === "function"
						? resourceId({ params })
						: resourceId;
				if (!docId) return;

				const userId = session.user.id;
				const tenantCtx: TenantContext = {
					userId,
					role: "user",
				};

				const [row] = await withTenant(tenantCtx, async (tx) =>
					tx
						.select({ ownerId: documents.ownerId })
						.from(documents)
						.where(eq(documents.id, docId))
						.limit(1),
				);

				if (!row || row.ownerId !== userId) {
					set.status = 403;
					return { error: "Not the owner of this resource" };
				}
			},
		});
}
