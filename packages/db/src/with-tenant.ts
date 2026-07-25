import { sql } from "drizzle-orm";
import { db, type Database } from "./client";

/** A transaction carrying the same query surface as the tenant-scoped DB. */
export type TenantTransaction = Parameters<
	Parameters<typeof db.transaction>[0]
>[0];

/**
 * Server-side adapter for packages that must run short actor-scoped database
 * transactions without importing this module's process-global client.
 */
export interface ActorScopedTransactionExecutor {
	withActorTransaction<T>(
		actorUserId: string,
		operation: (tx: TenantTransaction) => Promise<T>,
	): Promise<T>;
}

export function createActorScopedTransactionExecutor(
	database: Database,
): ActorScopedTransactionExecutor {
	return {
		withActorTransaction(actorUserId, operation) {
			return database.transaction(async (tx) => {
				await tx.execute(
					sql`SELECT set_config('app.current_user_id', ${actorUserId}, true)`,
				);
				await tx.execute(
					sql`SELECT set_config('app.current_user_role', 'user', true)`,
				);
				await tx.execute(
					sql`SELECT set_config('app.current_workspace_id', '', true)`,
				);
				return operation(tx);
			});
		},
	};
}

export interface TenantContext {
	userId: string;
	role: "admin" | "user" | "none";
	workspaceId?: string;
	source?: "personal" | "external";
	actorRole?: "owner" | "admin" | "editor" | "viewer";
	/** Unix timestamp from a verified external workspace assertion. */
	assertionExpiresAt?: number;
}

export const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Build an admin TenantContext.
 *
 * `ownerId` SHOULD be passed explicitly by the caller (typically resolved
 * from the hiai-docs `config.OWNER_ID` via the `tenant.ts` middleware).
 * If omitted, falls back to `process.env.OWNER_ID` so this package can
 * remain dependency-free while still working stand-alone.
 */
export function adminTenantContext(ownerId?: string): TenantContext {
	const resolved = ownerId ?? process.env.OWNER_ID;
	if (!resolved) {
		console.warn(
			"[hiai-docs/db] adminTenantContext: ownerId not provided and OWNER_ID env not set, using empty string",
		);
	}
	return {
		userId: resolved ?? "",
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
		await tx.execute(
			sql`SELECT set_config('app.current_workspace_id', ${ctx.workspaceId ?? ""}, true)`,
		);
		return fn(tx);
	});
}
