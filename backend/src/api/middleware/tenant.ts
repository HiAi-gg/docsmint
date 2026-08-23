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
import {
	DOCSMINT_WORKSPACE_CONTEXT_HEADER,
	type DocsmintWorkspaceContext,
	DocsmintWorkspaceContextError,
	verifyDocsmintWorkspaceAssertion,
} from "../../lib/external-tenant-context";
import type { TenantContext } from "../../lib/with-tenant";
import {
	adminTenantContext,
	shareGuestTenantContext,
	ZERO_UUID,
} from "../../lib/with-tenant";

export type { TenantContext };

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

export async function buildTenantContext(
	request: Request,
): Promise<TenantContext> {
	const workspaceAssertion = request.headers.get(
		DOCSMINT_WORKSPACE_CONTEXT_HEADER,
	);
	if (workspaceAssertion) {
		if (
			!config.DOCSMINT_WORKSPACE_ENABLED ||
			!config.DOCSMINT_WORKSPACE_SECRET ||
			!config.DOCSMINT_WORKSPACE_ISSUER
		)
			throw new DocsmintWorkspaceContextError(
				"Workspace context is not enabled",
			);
		let workspace: DocsmintWorkspaceContext;
		try {
			workspace = await verifyDocsmintWorkspaceAssertion(workspaceAssertion, {
				secret: config.DOCSMINT_WORKSPACE_SECRET,
				issuer: config.DOCSMINT_WORKSPACE_ISSUER,
				clockSkewSeconds: config.DOCSMINT_WORKSPACE_CLOCK_SKEW_SECONDS,
			});
		} catch (error) {
			throw new DocsmintWorkspaceContextError("Invalid workspace context", {
				cause: error,
			});
		}
		return {
			userId: workspace.actorUserId,
			role: "user",
			workspaceId: workspace.workspaceId,
			source: "external",
			actorRole: workspace.actorRole,
			resourceScope: workspace.resourceScope,
			assertionExpiresAt: workspace.expiresAt,
		};
	}
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
		source: "personal",
	};
}
