import { Elysia } from "elysia";
import type { RateLimitResult } from "../../lib/rate-limit-factory";
import { evaluatePipelineHealth } from "../../queue/health";

export interface HealthRouteDependencies {
	rateLimiter(ip: string, request: Request): Promise<RateLimitResult>;
	databaseAvailable(): Promise<boolean>;
	redisAvailable(): Promise<boolean>;
	storageAvailable(): Promise<boolean>;
	queueAvailable(): boolean;
}

export function createHealthRoutes(dependencies: HealthRouteDependencies) {
	return new Elysia().get("/api/health", async ({ request, set }) => {
		const ip =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"unknown";
		const rateLimit = await dependencies.rateLimiter(ip, request);
		set.headers = {
			"X-RateLimit-Remaining": String(rateLimit.remaining),
			...(rateLimit.retryAfter
				? { "Retry-After": String(rateLimit.retryAfter) }
				: {}),
		};
		if (!rateLimit.allowed) {
			set.status = 429;
			return { error: "Too many requests" };
		}

		const [databaseAvailable, redisAvailable, storageAvailable] =
			await Promise.all([
				dependencies.databaseAvailable(),
				dependencies.redisAvailable(),
				dependencies.storageAvailable(),
			]);
		const queueAvailable = dependencies.queueAvailable();
		const readiness = evaluatePipelineHealth({
			databaseAvailable,
			redisAvailable,
			storageAvailable,
			queueAvailable,
			recoveryAvailable: true,
			oldestInteractiveWaitMs: 0,
			interactiveSloMs: Number.POSITIVE_INFINITY,
			graphAvailable: true,
		});
		if (readiness.status === "unhealthy") set.status = 503;

		return {
			status: readiness.status === "unhealthy" ? "unhealthy" : "ok",
			service: "hiai-docs",
			timestamp: new Date().toISOString(),
			database: databaseAvailable ? "ok" : "error",
			redis: redisAvailable ? "ok" : "error",
			storage: storageAvailable ? "ok" : "error",
			queue: queueAvailable ? "ok" : "error",
			...(readiness.reasons.length ? { reasons: readiness.reasons } : {}),
		};
	});
}
