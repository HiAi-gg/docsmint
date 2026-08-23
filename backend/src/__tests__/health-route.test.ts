import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createHealthRoutes } from "../api/routes/health";

function availableDependencies() {
	return {
		rateLimiter: async () => ({ allowed: true, remaining: 119 }),
		databaseAvailable: async () => true,
		redisAvailable: async () => true,
		storageAvailable: async () => true,
		queueAvailable: () => true,
	};
}

describe("GET /api/health", () => {
	test("maps limiter denial to 429 with rate-limit headers", async () => {
		const app = new Elysia().use(
			createHealthRoutes({
				...availableDependencies(),
				rateLimiter: async () => ({
					allowed: false,
					remaining: 0,
					retryAfter: 42,
				}),
			}),
		);

		const response = await app.handle(
			new Request("http://localhost/api/health"),
		);

		expect(response.status).toBe(429);
		expect(response.headers.get("x-ratelimit-remaining")).toBe("0");
		expect(response.headers.get("retry-after")).toBe("42");
		expect(await response.json()).toEqual({ error: "Too many requests" });
	});

	test("maps a required dependency failure to 503", async () => {
		const app = new Elysia().use(
			createHealthRoutes({
				...availableDependencies(),
				databaseAvailable: async () => false,
			}),
		);

		const response = await app.handle(
			new Request("http://localhost/api/health"),
		);
		const body = (await response.json()) as {
			status: string;
			database: string;
			reasons: string[];
		};

		expect(response.status).toBe(503);
		expect(response.headers.get("x-ratelimit-remaining")).toBe("119");
		expect(body.status).toBe("unhealthy");
		expect(body.database).toBe("error");
		expect(body.reasons).toContain("database_unavailable");
	});
});
