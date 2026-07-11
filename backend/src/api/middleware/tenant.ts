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
import type { TenantContext } from "../../lib/with-tenant";
import {
	adminTenantContext,
	shareGuestTenantContext,
	ZERO_UUID,
} from "../../lib/with-tenant";

export type { TenantContext };

// Re-export from the canonical source in @hiai-docs/db/with-tenant. The admin
// role bypasses tenant RLS, but PostgreSQL still casts current_user_id to UUID
// in policy expressions. A fresh install intentionally ships with a textual
// OWNER_ID placeholder until the first account is registered, so internal
// admin reads (notably public share-token lookup) need a valid neutral UUID in
// that state rather than failing every query with an invalid UUID cast.
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const adminTenantContextBound = () =>
	adminTenantContext(
		UUID_PATTERN.test(config.OWNER_ID) ? config.OWNER_ID : ZERO_UUID,
	);
export {
	adminTenantContextBound as adminTenantContext,
	shareGuestTenantContext,
};

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
