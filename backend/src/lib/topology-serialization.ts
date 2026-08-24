import type {
	TenantContext,
	TenantTransaction,
} from "@hiai-docs/db/with-tenant";
import { sql } from "drizzle-orm";

const TOPOLOGY_LOCK_NAMESPACE = "docsmint:folder-topology:v1";
const SIGNED_64_BIT_LIMIT = 1n << 63n;
const UNSIGNED_64_BIT_LIMIT = 1n << 64n;

/** Stable, unambiguous identity for one personal or external workspace tenant. */
export function tenantTopologyLockIdentity(ctx: TenantContext): string {
	const tenant =
		ctx.source === "external" && ctx.workspaceId
			? (["workspace", ctx.workspaceId] as const)
			: (["personal", ctx.userId] as const);
	return JSON.stringify([TOPOLOGY_LOCK_NAMESPACE, ...tenant]);
}

/**
 * Map the canonical tenant identity to PostgreSQL's signed 64-bit advisory
 * lock space. SHA-256 keeps the practical collision risk negligible while
 * the JSON tuple prevents delimiter/concatenation ambiguity before hashing.
 */
export function tenantTopologyLockKey(ctx: TenantContext): bigint {
	const prefix = new Bun.CryptoHasher("sha256")
		.update(tenantTopologyLockIdentity(ctx))
		.digest("hex")
		.slice(0, 16);
	const unsigned = BigInt(`0x${prefix}`);
	return unsigned >= SIGNED_64_BIT_LIMIT
		? unsigned - UNSIGNED_64_BIT_LIMIT
		: unsigned;
}

/** Serialize topology discovery and mutation for exactly one tenant. */
export async function acquireTenantTopologyLock(
	tx: TenantTransaction,
	ctx: TenantContext,
): Promise<void> {
	const key = tenantTopologyLockKey(ctx);
	await tx.execute(sql`
		/* docsmint:tenant-topology-lock */
		SELECT pg_advisory_xact_lock(${key})
	`);
}
