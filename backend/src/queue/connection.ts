import type { ConnectionOptions } from "bullmq";

export function createBullMqConnection(redisUrl: string): ConnectionOptions {
	const url = new URL(redisUrl);
	if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
		throw new Error("BullMQ requires a redis:// or rediss:// URL");
	}
	const database = url.pathname.slice(1);
	return {
		host: url.hostname,
		port: Number(url.port || 6379),
		username: url.username ? decodeURIComponent(url.username) : undefined,
		password: url.password ? decodeURIComponent(url.password) : undefined,
		db: database ? Number(database) : 0,
		tls: url.protocol === "rediss:" ? {} : undefined,
		maxRetriesPerRequest: null,
	};
}
