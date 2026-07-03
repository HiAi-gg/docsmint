import Redis from "ioredis";
import { config } from "./config";
import { logger } from "./logger";

export interface RedisConfig {
	url: string;
	maxRetriesPerRequest: number;
}

export function createRedis(cfg: RedisConfig): Redis {
	const instance = new Redis(cfg.url, {
		maxRetriesPerRequest: cfg.maxRetriesPerRequest,
		retryStrategy(times) {
			const delay = Math.min(times * 200, 2000);
			return delay;
		},
	});

	instance.on("error", (err) => {
		logger.error({ err }, "Redis connection error");
	});

	instance.on("connect", () => {
		logger.info("Redis connected");
	});

	return instance;
}

// Backwards-compatible singleton (crash at import-time if REDIS_URL is missing — same
// behaviour as before the DI refactor, when the constructor was always called).
export const redis: Redis = (() => {
	if (!config.REDIS_URL) throw new Error("REDIS_URL is required");
	return createRedis({ url: config.REDIS_URL, maxRetriesPerRequest: 3 });
})();
