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
	workspaceId?: string,
): string {
	// LIST_PREFIX already ends with `:`. Starting with it as a separate
	// `join(":")` segment produced a double-colon key (`list::user`) while
	// invalidation scans `list:user:*`. Those keys never matched, so placement
	// PATCHes could succeed while the sidebar kept reading the stale list until
	// Redis TTL expiry.
	const parts = [`${LIST_PREFIX}${userId}`];
	if (workspaceId) parts.push(`w:${workspaceId}`);
	if (folderId) parts.push(`f:${folderId}`);
	if (tag) parts.push(`t:${tag}`);
	parts.push(`p:${page}`, `l:${limit}`);
	return parts.join(":");
}

export function docSingleKey(
	docId: string,
	userId: string,
	workspaceId?: string,
): string {
	// Tenant-scope the single-doc cache: User A's cached fetch must not
	// be returned to User B even if both happen to query the same `docId`
	// in succession. See invalidateDocCache for the matching wildcard
	// invalidation that clears every user's variant on write.
	return `${SINGLE_PREFIX}${userId}${workspaceId ? `:w:${workspaceId}` : ""}:${docId}`;
}

export async function cacheGetOrSet<T>(
	key: string,
	ttl: number,
	compute: () => Promise<T>,
	options: { shouldCache?: (value: T) => boolean } = {},
): Promise<T> {
	try {
		const cached = await redis.get(key);
		if (cached) return JSON.parse(cached) as T;
	} catch (err) {
		logger.warn({ err, key }, "Redis get failed, falling through to DB");
	}
	const value = await compute();
	if (options.shouldCache && !options.shouldCache(value)) return value;
	try {
		await redis.set(key, JSON.stringify(value), "EX", ttl);
	} catch (err) {
		logger.warn({ err, key }, "Redis set failed");
	}
	return value;
}

export type HttpCacheValue<T> = Readonly<{
	status: number;
	body: T;
}>;

export type HttpCacheResult<T> = HttpCacheValue<T> &
	Readonly<{ cacheHit: boolean }>;

type HttpCacheEnvelope<T> = Readonly<{
	version: 1;
	kind: "http-response";
	status: number;
	body: T;
}>;

function isHttpCacheEnvelope(
	value: unknown,
): value is HttpCacheEnvelope<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"version" in value &&
		value.version === 1 &&
		"kind" in value &&
		value.kind === "http-response" &&
		"status" in value &&
		typeof value.status === "number" &&
		Number.isInteger(value.status) &&
		value.status >= 100 &&
		value.status <= 599 &&
		"body" in value
	);
}

/** Cache a response body together with the status required to replay it. */
export async function cacheHttpResponse<T>(
	key: string,
	ttl: number,
	compute: () => Promise<HttpCacheValue<T>>,
	options: {
		shouldCache?: (value: HttpCacheValue<T>) => boolean;
	} = {},
): Promise<HttpCacheResult<T>> {
	try {
		const cached = await redis.get(key);
		if (cached) {
			const parsed: unknown = JSON.parse(cached);
			if (isHttpCacheEnvelope(parsed)) {
				return {
					status: parsed.status,
					body: parsed.body as T,
					cacheHit: true,
				};
			}
		}
	} catch (err) {
		logger.warn(
			{ err, key },
			"Redis HTTP cache get failed, falling through to DB",
		);
	}

	const value = await compute();
	if (options.shouldCache && !options.shouldCache(value)) {
		return { ...value, cacheHit: false };
	}
	const envelope: HttpCacheEnvelope<T> = {
		version: 1,
		kind: "http-response",
		status: value.status,
		body: value.body,
	};
	try {
		await redis.set(key, JSON.stringify(envelope), "EX", ttl);
	} catch (err) {
		logger.warn({ err, key }, "Redis HTTP cache set failed");
	}
	return { ...value, cacheHit: false };
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
	// Read keys append the authorized category scope after the document id.
	// Keep that suffix in the pattern; otherwise a successful save leaves the
	// just-read `:scope:*` entry alive and the editor reloads stale content.
	const pattern = `${SINGLE_PREFIX}*:${docId}:scope:*`;
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
