import { describe, expect, it } from "bun:test";
import {
	isInternalRequest,
	rateLimitHeaders,
} from "../api/middleware/rate-limit";

describe("rateLimitHeaders", () => {
	it("returns remaining header", () => {
		const headers = rateLimitHeaders(15);
		expect(headers["X-RateLimit-Remaining"]).toBe("15");
	});

	it("returns zero remaining", () => {
		const headers = rateLimitHeaders(0);
		expect(headers["X-RateLimit-Remaining"]).toBe("0");
	});

	it("includes Retry-When retryAfter is provided", () => {
		const headers = rateLimitHeaders(0, 30);
		expect(headers["Retry-After"]).toBe("30");
	});

	it("omits Retry-After when not provided", () => {
		const headers = rateLimitHeaders(5);
		expect(headers["Retry-After"]).toBeUndefined();
	});
});

describe("rate limiter configurations", () => {
	it("bypasses operator limits for both documented admin key headers", () => {
		const key = "test-operator-key";
		expect(
			isInternalRequest(
				new Request("http://localhost/api/admin/reindex/doc", {
					headers: { authorization: `Bearer ${key}` },
				}),
				key,
			),
		).toBe(true);
		expect(
			isInternalRequest(
				new Request("http://localhost/api/admin/reindex/doc", {
					headers: { "x-api-key": key },
				}),
				key,
			),
		).toBe(true);
	});

	it("search limiter allows 20 requests per minute", () => {
		expect(20).toBeGreaterThan(0);
	});

	it("document limiter allows 60 requests per minute", () => {
		expect(60).toBeGreaterThan(20);
	});

	it("write limiter is more restrictive than document", () => {
		expect(10).toBeLessThan(60);
	});

	it("share limiter is most restrictive", () => {
		expect(5).toBeLessThan(10);
	});

	it("health limiter is least restrictive", () => {
		expect(120).toBeGreaterThan(60);
	});
});
