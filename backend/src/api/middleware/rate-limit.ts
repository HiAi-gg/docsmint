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
export const documentRateLimiter = createRateLimiter({
	windowSec: 60,
	max: 60,
	keyPrefix: "docs",
});
export const writeRateLimiter = createRateLimiter({
	windowSec: 60,
	max: 20,
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
