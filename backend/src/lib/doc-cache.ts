import { logger } from "./logger";
import { redis } from "./redis";

const DOC_SINGLE_TTL = 60; // seconds
const DOC_LIST_TTL = 30; // seconds
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

export function docSingleKey(docId: string): string {
	return `${SINGLE_PREFIX}${docId}`;
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
	try {
		await redis.del(docSingleKey(docId));
	} catch (err) {
		logger.warn({ err, docId }, "Failed to invalidate doc cache");
	}
}
