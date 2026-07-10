import { apiKeys } from "@hiai-docs/db/schema";
import {
	adminTenantContext,
	withTenant,
	ZERO_UUID,
} from "@hiai-docs/db/with-tenant";
import { and, desc, eq } from "drizzle-orm";

const API_KEY_ADMIN_TENANT = adminTenantContext(ZERO_UUID);

/**
 * Hash a raw API key with SHA-256.
 */
function hashKey(key: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(key);
	return hasher.digest("hex");
}

/**
 * Create a new API key for a user.
 *
 * Returns the raw key (only time it is ever exposed), the prefix, and the DB id.
 */
export async function createApiKey(
	ownerId: string,
	name: string,
	scopes?: string[],
	expiresAt?: Date,
): Promise<{ key: string; prefix: string; id: string }> {
	const rawKey = crypto.randomUUID();
	const keyHash = hashKey(rawKey);
	const prefix = rawKey.slice(0, 8);

	const [row] = await withTenant({ userId: ownerId, role: "user" }, (tx) =>
		tx
			.insert(apiKeys)
			.values({
				ownerId,
				name,
				keyHash,
				prefix,
				scopes: scopes ?? [],
				expiresAt: expiresAt ?? null,
			})
			.returning({ id: apiKeys.id }),
	);

	if (!row) {
		throw new Error("Failed to create API key");
	}

	return { key: rawKey, prefix, id: row.id };
}

/**
 * List all API keys for a user (excludes the key hash).
 */
export async function listApiKeys(ownerId: string): Promise<
	Array<{
		id: string;
		name: string;
		prefix: string;
		scopes: string[];
		lastUsedAt: Date | null;
		expiresAt: Date | null;
		createdAt: Date;
	}>
> {
	const rows = await withTenant({ userId: ownerId, role: "user" }, (tx) =>
		tx
			.select({
				id: apiKeys.id,
				name: apiKeys.name,
				prefix: apiKeys.prefix,
				scopes: apiKeys.scopes,
				lastUsedAt: apiKeys.lastUsedAt,
				expiresAt: apiKeys.expiresAt,
				createdAt: apiKeys.createdAt,
			})
			.from(apiKeys)
			.where(eq(apiKeys.ownerId, ownerId))
			.orderBy(desc(apiKeys.createdAt)),
	);

	return rows.map((r) => ({
		...r,
		scopes: (r.scopes ?? []) as string[],
	}));
}

/**
 * Revoke (delete) an API key by id and ownerId.
 * Returns true if a key was deleted.
 */
export async function revokeApiKey(
	id: string,
	ownerId: string,
): Promise<boolean> {
	const deleted = await withTenant({ userId: ownerId, role: "user" }, (tx) =>
		tx
			.delete(apiKeys)
			.where(and(eq(apiKeys.id, id), eq(apiKeys.ownerId, ownerId)))
			.returning({ id: apiKeys.id }),
	);

	return deleted.length > 0;
}

/**
 * Validate an API key.
 * Returns { ownerId, scopes } if valid, or null if not found / expired.
 * Updates lastUsedAt on successful validation.
 */
export async function validateApiKey(
	key: string,
): Promise<{ ownerId: string; scopes: string[] } | null> {
	const keyHash = hashKey(key);

	const [row] = await withTenant(API_KEY_ADMIN_TENANT, (tx) =>
		tx
			.select({
				id: apiKeys.id,
				ownerId: apiKeys.ownerId,
				scopes: apiKeys.scopes,
				expiresAt: apiKeys.expiresAt,
			})
			.from(apiKeys)
			.where(eq(apiKeys.keyHash, keyHash))
			.limit(1),
	);

	if (!row) {
		return null;
	}

	// Check expiration
	if (row.expiresAt && new Date(row.expiresAt) < new Date()) {
		return null;
	}

	// Update last_used_at
	await withTenant(API_KEY_ADMIN_TENANT, (tx) =>
		tx
			.update(apiKeys)
			.set({ lastUsedAt: new Date() })
			.where(eq(apiKeys.id, row.id)),
	);

	return {
		ownerId: row.ownerId,
		scopes: (row.scopes as string[]) ?? [],
	};
}
