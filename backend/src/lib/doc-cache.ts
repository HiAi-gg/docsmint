import { logger } from "./logger";
import { redis } from "./redis";

const LIST_PREFIX = "hiai-docs:cache:docs:list:";
const SINGLE_PREFIX = "hiai-docs:cache:docs:single:";

export function docListKey(
	userId: string,
	folderId?: string,
	tag?: string,
	page = 1,
	limit = 20,
): string {
	const parts = [LIST_PREFIX, userId];
	if (folderId) parts.push(`f:${folderId}`);
	if (tag) parts.push(`t:${tag}`);
	parts.push(`p:${page}`, `l:${limit}`);
	return parts.join(":");
}

export function docSingleKey(docId: string, userId: string): string {
	// Tenant-scope the single-doc cache: User A's cached fetch must not
	// be returned to User B even if both happen to query the same `docId`
	// in succession. See invalidateDocCache for the matching wildcard
	// invalidation that clears every user's variant on write.
	return `${SINGLE_PREFIX}${userId}:${docId}`;
}

export async function cacheGetOrSet<T>(
	key: string,
	ttl: number,
	compute: () => Promise<T>,
): Promise<T> {
	try {
		const cached = await redis.get(key);
		if (cached) return JSON.parse(cached) as T;
	} catch (err) {
		logger.warn({ err, key }, "Redis get failed, falling through to DB");
	}
	const value = await compute();
	try {
		await redis.set(key, JSON.stringify(value), "EX", ttl);
	} catch (err) {
		logger.warn({ err, key }, "Redis set failed");
	}
	return value;
}

export async function invalidateDocListCache(userId: string): Promise<void> {
	const pattern = `${LIST_PREFIX}${userId}:*`;
	try {
		let cursor = "0";
		do {
			const [newCursor, keys] = await redis.scan(
				cursor,
				"MATCH",
				pattern,
				"COUNT",
				100,
			);
			cursor = newCursor;
			if (keys.length > 0) await redis.del(...keys);
		} while (cursor !== "0");
	} catch (err) {
		logger.warn({ err, userId }, "Failed to invalidate doc list cache");
	}
}

export async function invalidateDocCache(docId: string): Promise<void> {
	// Single-doc keys are scoped per-user (see docSingleKey), so we must
	// clear every tenant variant on a write/delete. Use SCAN to walk
	// the prefix without blocking Redis on KEYS, and DEL the matching
	// batch in chunks so a doc shared across many users does not blow
	// up the command argv.
	const pattern = `${SINGLE_PREFIX}*:${docId}`;
	try {
		let cursor = "0";
		do {
			const [newCursor, keys] = await redis.scan(
				cursor,
				"MATCH",
				pattern,
				"COUNT",
				100,
			);
			cursor = newCursor;
			if (keys.length > 0) await redis.del(...keys);
		} while (cursor !== "0");
	} catch (err) {
		logger.warn({ err, docId }, "Failed to invalidate doc cache");
	}
}
