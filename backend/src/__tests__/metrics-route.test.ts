/**
 * Behavioural tests for `GET /api/admin/metrics`.
 *
 * Boots the metrics route in-process and drives it with Request objects
 * to validate the auth gate and the response shape. The rate-limiter
 * middleware is mocked so the test path stays independent of any shared
 * Redis state (the test focuses on the auth-gate contract, not on
 * rate-limiter semantics — those are covered by `rate-limit.test.ts`).
 *
 * `config.HIAI_DOCS_API_KEY` is parsed at module-load time and cached as
 * a plain object — we mutate it directly here so the route picks up our
 * test key without needing a fresh process. The original value is
 * restored in cleanup so other test files are not affected.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
// `mock.module` is process-global in Bun, so we have to delegate the
// helper functions we don't actually need to stub (notably
// `rateLimitHeaders`) to the REAL implementation. Importing the real
// module via a static `import` is hoisted by the ESM spec to the top
// of the file, which means we capture the unstubbed reference before
// `mock.module` is registered below — even though the import appears
// textually after this comment.
import * as realRateLimit from "../api/middleware/rate-limit";
import {
	getMetrics,
	incrementCounter,
	METRIC_NAMES,
	recordDuration,
	resetMetrics,
} from "../lib/metrics";

// Stub the rate-limit middleware so every request in this file is allowed
// regardless of Redis state or bucket count. Registered BEFORE the route
// module is imported so the route picks up the stubbed `searchRateLimiter`.
//
// `rateLimitHeaders` deliberately delegates to the real implementation
// rather than returning `{}` so any sibling test file (notably
// `src/__tests__/rate-limit.test.ts`) that loads
// `../api/middleware/rate-limit` through this stub still sees the
// proper `X-RateLimit-Remaining` / `Retry-After` headers.
mock.module("../api/middleware/rate-limit", () => ({
	searchRateLimiter: async () => ({ allowed: true, remaining: 999 }),
	rateLimitHeaders: realRateLimit.rateLimitHeaders,
	documentRateLimiter: async () => ({ allowed: true, remaining: 999 }),
	writeRateLimiter: async () => ({ allowed: true, remaining: 999 }),
	shareRateLimiter: async () => ({ allowed: true, remaining: 999 }),
	healthRateLimiter: async () => ({ allowed: true, remaining: 999 }),
}));

const TEST_API_KEY = "test-admin-metrics-key";

afterEach(() => {
	resetMetrics();
});

describe("GET /api/admin/metrics", () => {
	let originalKey: string | undefined;

	test("end-to-end: auth gate + response shape", async () => {
		// Import lazily so this is the only test file that pays the cost
		// of booting Elysia. The route module + config live in this scope.
		const { config } = await import("../lib/config");
		originalKey = config.HIAI_DOCS_API_KEY;
		config.HIAI_DOCS_API_KEY = TEST_API_KEY;

		const { metricsRoutes } = await import("../api/routes/metrics");
		const ElysiaCtor = (await import("elysia")).Elysia;
		const app = new ElysiaCtor().use(metricsRoutes);

		try {
			// --- Auth gate: missing key → 401
			const noKey = await app.handle(
				new Request("http://localhost/api/admin/metrics"),
			);
			expect(noKey.status).toBe(401);
			const noKeyBody = (await noKey.json()) as { error: string };
			expect(noKeyBody.error).toBe("Unauthorized");

			// --- Auth gate: wrong key → 401
			const wrongKey = await app.handle(
				new Request("http://localhost/api/admin/metrics", {
					headers: { "x-api-key": "definitely-not-the-real-key" },
				}),
			);
			expect(wrongKey.status).toBe(401);

			// --- Happy path: matching key → 200 with snapshot
			resetMetrics();
			incrementCounter(METRIC_NAMES.EMBEDDING_SUCCESS);
			incrementCounter(METRIC_NAMES.EMBEDDING_SUCCESS);
			recordDuration(METRIC_NAMES.EMBEDDING_DURATION_MS, 42);
			incrementCounter(METRIC_NAMES.EMBEDDING_DOCS_TOTAL);

			const ok = await app.handle(
				new Request("http://localhost/api/admin/metrics", {
					headers: { "x-api-key": TEST_API_KEY },
				}),
			);
			expect(ok.status).toBe(200);

			const bearerOk = await app.handle(
				new Request("http://localhost/api/admin/metrics", {
					headers: { authorization: `Bearer ${TEST_API_KEY}` },
				}),
			);
			expect(bearerOk.status).toBe(200);
			const body = (await ok.json()) as {
				metrics: Record<string, number | number[]>;
				embeddingStateInventory: Record<string, number>;
				uptime: number;
			};
			expect(typeof body.uptime).toBe("number");
			expect(body.uptime).toBeGreaterThanOrEqual(0);
			expect(body.metrics[METRIC_NAMES.EMBEDDING_SUCCESS]).toBe(2);
			expect(body.metrics[METRIC_NAMES.EMBEDDING_DOCS_TOTAL]).toBe(1);
			expect(body.embeddingStateInventory).toEqual({
				pending: 0,
				processing: 0,
				ready: 0,
				failed: 0,
				stale: 0,
				invalidActive: 0,
			});
			const durations = body.metrics[
				METRIC_NAMES.EMBEDDING_DURATION_MS
			] as number[];
			expect(Array.isArray(durations)).toBe(true);
			expect(durations).toContain(42);

			// --- Snapshot stability: the route reads the same registry the
			// lib exposes, so cross-checking the direct snapshot guards
			// against an accidental disconnected store.
			const local = getMetrics();
			expect(local[METRIC_NAMES.EMBEDDING_SUCCESS]).toBe(2);
			expect(local[METRIC_NAMES.EMBEDDING_DOCS_TOTAL]).toBe(1);
		} finally {
			resetMetrics();
			// Restore original config so this test doesn't pollute later
			// files in the same process.
			config.HIAI_DOCS_API_KEY = originalKey;
		}
	});
});
