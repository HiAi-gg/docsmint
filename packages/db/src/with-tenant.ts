import { sql } from "drizzle-orm";
import { db } from "./client";

export interface TenantContext {
	userId: string;
	role: "admin" | "user" | "none";
}

export const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export function adminTenantContext(): TenantContext {
	const ownerId = process.env.OWNER_ID;
	if (!ownerId) {
		console.warn(
			"[hiai-docs/db] adminTenantContext: OWNER_ID env not set, using empty string",
		);
	}
	return {
		userId: ownerId ?? "",
		role: "admin",
	};
}

export function shareGuestTenantContext(ownerId: string): TenantContext {
	return {
		userId: ownerId,
		role: "user",
	};
}

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
 */
export async function withTenant<T>(
	ctx: TenantContext,
	fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`SELECT set_config('app.current_user_id', ${ctx.userId}, true)`,
		);
		await tx.execute(
			sql`SELECT set_config('app.current_user_role', ${ctx.role}, true)`,
		);
		return fn(tx);
	});
}
