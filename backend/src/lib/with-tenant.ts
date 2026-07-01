import { sql } from "drizzle-orm";
import { type TenantContext, ZERO_UUID } from "../api/middleware/tenant";
import { db } from "./db";

export type { TenantContext };
// Re-export for callers that prefer importing from `with-tenant`.
export { ZERO_UUID };

/**
 * Run `fn` inside a `db.transaction(...)` with the per-request RLS
 * GUCs (`app.current_user_id`, `app.current_user_role`) installed
 * on the transaction's connection.
 *
 * The transaction pins a single pooled connection for the duration
 * of `fn`, so every query inside `fn` runs on the same connection
 * where the GUCs were installed. This works around the
 * `postgres-js` connection-pool round-robin: a single
 * `set_config(..., false)` outside a transaction would land on a
 * different connection than the route handler's first query, and
 * RLS would fail closed.
 *
 * GUCs use `set_config(..., true)` (transaction-local), so they
 * automatically reset when the transaction commits/rolls back and
 * cannot leak into the next request that reuses the connection.
 *
 * The caller must supply a `TenantContext` explicitly. The previous
 * AsyncLocalStorage-based design relied on Elysia plugin hooks
 * propagating the context to parent-app routes — which the
 * framework does not do reliably — so the ALS lookup was silently
 * returning `undefined` for many endpoints. The explicit context
 * argument makes every RLS-aware query visible at the call site
 * and removes the dependency on plugin hook scope.
 *
 * Typical usage:
 * ```ts
 * const ctx = await buildTenantContext(request);
 * if (ctx.role === "none") return { error: "Unauthorized" };
 * const rows = await withTenant(ctx, async (tx) => {
 *   return tx.select().from(documents).where(eq(documents.ownerId, ctx.userId));
 * });
 * ```
 */
export async function withTenant<T>(
	ctx: TenantContext,
	fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
	return db.transaction(async (tx) => {
		// Two separate `set_config` calls rather than one combined
		// statement: `postgres-js` parameterises each query individually
		// and round-robins connections across the pool, so a single
		// multi-statement query with two `${}` bindings can be reordered
		// relative to the subsequent `fn(tx)` calls. Splitting the GUC
		// sets into two queries (each pinned to the transaction's
		// connection) guarantees both GUCs are installed on the same
		// connection that runs the user's queries inside `fn(tx)`.
		await tx.execute(
			sql`SELECT set_config('app.current_user_id', ${ctx.userId}, true)`,
		);
		await tx.execute(
			sql`SELECT set_config('app.current_user_role', ${ctx.role}, true)`,
		);
		return fn(tx);
	});
}
