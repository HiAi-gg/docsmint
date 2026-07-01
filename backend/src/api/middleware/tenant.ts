/**
 * Tenant context resolution helper.
 *
 * Earlier versions of this file exported an Elysia plugin
 * (`tenantMiddleware`) that ran in the parent's `onBeforeHandle` /
 * `derive` hook and stored the resolved context in an
 * `AsyncLocalStorage`. That approach failed in production because
 * Elysia 1.4.x plugin hooks only fire for routes registered inside
 * the plugin's own scope — routes defined directly on the parent app
 * never triggered the hook, so the ALS slot was `undefined` for the
 * bulk of the API surface and every `withTenant(fn)` call fell through
 * to the unprotected `db`.
 *
 * The reliable replacement is explicit context resolution at the top
 * of every route handler:
 *
 * ```ts
 * const ctx = await buildTenantContext(request);
 * if (ctx.role === "none") return { error: "Unauthorized" };
 * const result = await withTenant(ctx, async (tx) => { ... });
 * ```
 *
 * `buildTenantContext` consolidates the API-key vs Better Auth session
 * resolution in one place so individual route handlers do not need to
 * re-implement it. It also classifies the role (`admin` / `user` /
 * `none`) based on the `ADMIN_CROSS_TENANT` flag and whether the
 * caller presented the operator API key.
 *
 * For share-token public endpoints (no authenticated session, no API
 * key) the caller can either pass `ctx.role === 'none'` and rely on
 * the share-link lookup, or explicitly substitute `role: 'admin'` to
 * allow RLS-bypassed lookups for that single transaction.
 */

import { getSessionUserId } from "../../lib/auth-helpers";
import { config } from "../../lib/config";

/**
 * Tenant context type — defined here (rather than in `@hiai-docs/db`)
 * so importing the type does NOT trigger the package's `index.ts`
 * re-evaluation. `packages/db/src/index.ts` re-exports from `./client`,
 * which constructs the Drizzle client and walks the schema. The
 * HNSW index in the schema triggers a JSON parse error under
 * `drizzle-orm/pg-core/indexes.js` when the schema is loaded without
 * a real DB connection (e.g. inside the integration test harness
 * where postgres is mocked). Keeping the type local to the backend
 * avoids that path for callers that only need the type.
 */
export interface TenantContext {
	userId: string;
	role: "admin" | "user" | "none";
}

/**
 * `00000000-0000-0000-0000-000000000000` — the UUID sentinel used as
 * `current_user_id` when the request is unauthenticated or has no
 * resolvable user. RLS policies evaluate this sentinel as `no rows
 * match`, which is the correct fail-closed behavior for anonymous
 * traffic against a tenant table.
 */
export const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Resolve the caller's `TenantContext` from the request headers.
 *
 * Resolution order:
 *   1. API key (`Authorization: Bearer <HIAI_DOCS_API_KEY>`) →
 *      `userId = OWNER_ID`, role `admin` when
 *      `ADMIN_CROSS_TENANT=true`, else `user`.
 *   2. Better Auth session cookie → role `user`.
 *   3. No credential → `{ userId: ZERO_UUID, role: 'none' }` so RLS
 *      fails closed on tenant-scoped tables.
 */
export async function buildTenantContext(
	request: Request,
): Promise<TenantContext> {
	const userId = await getSessionUserId(request.headers);
	const authHeader = request.headers.get("authorization");
	const isApiKey =
		!!config.HIAI_DOCS_API_KEY &&
		!!authHeader?.startsWith("Bearer ") &&
		authHeader.slice(7) === config.HIAI_DOCS_API_KEY;
	const role: "admin" | "user" | "none" = !userId
		? "none"
		: isApiKey && config.ADMIN_CROSS_TENANT
			? "admin"
			: "user";
	return {
		userId: userId ?? ZERO_UUID,
		role,
	};
}

/**
 * Build an admin context backed by the configured `OWNER_ID`. Used by
 * public share-link lookups: the share token itself acts as the
 * authorization credential, so opening an admin-scoped transaction for
 * the lookup is acceptable (admin can only see what the token points
 * at, and only via the limited share-link query in `shareTokenAccessForDocument`).
 *
 * For read-only document/folder hydration under a share token, callers
 * should instead resolve `link.createdBy` and pass that as the user id
 * with role `'user'` so subsequent queries run with the owner's RLS
 * scope (which is the same data the share link was created against).
 */
export function adminTenantContext(): TenantContext {
	return {
		userId: config.OWNER_ID,
		role: "admin",
	};
}

/**
 * Build a "share guest" context — i.e. one that has no real userId but
 * is being authorized via a share link. The `userId` is the link's
 * `createdBy` (the document owner), so subsequent queries against
 * `documents` / `folders` run with that owner's RLS scope.
 */
export function shareGuestTenantContext(ownerId: string): TenantContext {
	return {
		userId: ownerId,
		role: "user",
	};
}
