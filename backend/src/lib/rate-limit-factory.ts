import { redis } from "./redis";

// Reusable types
export interface RateLimitConfig {
	windowSec: number;
	max: number;
	keyPrefix: string;
}

export interface RateLimitResult {
	allowed: boolean;
	remaining: number;
	retryAfter?: number;
}

export interface RateLimitRedisClient {
	incr(key: string): Promise<number>;
	expire(key: string, seconds: number): Promise<number>;
	ttl(key: string): Promise<number>;
}

// Redis is injected as optional dependency, defaults to singleton
export function createRateLimiter(
	config: RateLimitConfig,
	redisClient?: RateLimitRedisClient,
) {
	const client = redisClient ?? redis;
	return async (ip: string): Promise<RateLimitResult> => {
		const key = `hiai-docs:${config.keyPrefix}:${ip}`;
		try {
			const count = await client.incr(key);
			if (count === 1) {
				await client.expire(key, config.windowSec);
			} else {
				const ttl = await client.ttl(key);
				if (ttl === -1) {
					await client.expire(key, config.windowSec);
				}
			}
			const remaining = Math.max(0, config.max - count);
			if (count > config.max) {
				const ttl = await client.ttl(key);
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
