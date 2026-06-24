import { redis } from "../../lib/redis";

interface RateLimitConfig {
	windowSec: number;
	max: number;
	keyPrefix: string;
}

function _getClientIp(request: Request): string {
	return (
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
		request.headers.get("x-real-ip") ??
		"unknown"
	);
}

export function createRateLimiter(config: RateLimitConfig) {
	return async (
		ip: string,
	): Promise<{ allowed: boolean; remaining: number; retryAfter?: number }> => {
		const key = `hiai-docs:${config.keyPrefix}:${ip}`;
		try {
			const count = await redis.incr(key);
			if (count === 1) {
				await redis.expire(key, config.windowSec);
			} else {
				// Defensive: if a key exists with no TTL (TTL === -1), it
				// would block forever once we hit `max`. This can happen
				// if a previous `expire` call silently failed (Redis
				// restart, network blip, or a key that was set by a
				// different process). Re-apply the window so the bucket
				// eventually resets.
				const ttl = await redis.ttl(key);
				if (ttl === -1) {
					await redis.expire(key, config.windowSec);
				}
			}
			const remaining = Math.max(0, config.max - count);
			if (count > config.max) {
				const ttl = await redis.ttl(key);
				return {
					allowed: false,
					remaining: 0,
					retryAfter: ttl > 0 ? ttl : config.windowSec,
				};
			}
			return { allowed: true, remaining };
		} catch {
			return { allowed: false, remaining: 0, retryAfter: 60 };
		}
	};
}

export const searchRateLimiter = createRateLimiter({
	windowSec: 60,
	max: 20,
	keyPrefix: "search",
});
// Document rate limiter covers both reads (listDocuments, getDocument) and
// document-level write operations. The sidebar mounts two listDocuments
// callers (RecentDocs with limit=6, FolderTree with limit=100) and the
// dashboard makes its own listDocuments call (limit=6) — three
// concurrent fetches at cold load. Threshold raised to 1000/60s so a
// normal session can issue reads from the sidebar plus a generous pool
// of writes per minute without tripping 429s. The shareRateLimiter /
// writeRateLimiter still gate the truly expensive write paths
// separately.
//
// Combined with client-side request deduplication in
// `frontend/src/lib/api/documents.ts`, identical concurrent calls (e.g.
// RecentDocs and Dashboard both ask for limit=6 with no tag) collapse to
// a single network request, so this 1000/60s budget is more than enough
// for any realistic session burst.
export const documentRateLimiter = createRateLimiter({
	windowSec: 60,
	max: 1000,
	keyPrefix: "docs",
});
export const writeRateLimiter = createRateLimiter({
	windowSec: 60,
	max: 60,
	keyPrefix: "write",
});
export const shareRateLimiter = createRateLimiter({
	windowSec: 60,
	max: 5,
	keyPrefix: "share",
});
export const healthRateLimiter = createRateLimiter({
	windowSec: 60,
	max: 120,
	keyPrefix: "health",
});

export function rateLimitHeaders(remaining: number, retryAfter?: number) {
	const headers: Record<string, string> = {
		"X-RateLimit-Remaining": String(remaining),
	};
	if (retryAfter) {
		headers["Retry-After"] = String(retryAfter);
	}
	return headers;
}
