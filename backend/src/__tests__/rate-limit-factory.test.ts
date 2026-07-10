import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
	createRateLimiter,
	type RateLimitResult,
} from "../lib/rate-limit-factory";

// ---------------------------------------------------------------------------
// Mock Redis (installed per-test via mock.module)
// ---------------------------------------------------------------------------

let incrResult = 1;
let ttlResult = 60;

const fakeRedis = {
	incr: async (_key: string) => incrResult,
	expire: async (_key: string, _secs: number) => 1,
	ttl: async (_key: string) => ttlResult,
};

function applyMock() {
	mock.module("../lib/redis", () => ({
		redis: fakeRedis,
	}));
}

beforeEach(() => {
	incrResult = 1;
	ttlResult = 60;
	applyMock();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRateLimiter", () => {
	it("returns a function", async () => {
		const limiter = createRateLimiter({
			windowSec: 60,
			max: 10,
			keyPrefix: "test",
		});
		expect(typeof limiter).toBe("function");
	});

	it("returns correct RateLimitResult shape on allow", async () => {
		const limiter = createRateLimiter({
			windowSec: 60,
			max: 10,
			keyPrefix: "test",
		});
		const result = await limiter("127.0.0.1");
		expect(typeof result.allowed).toBe("boolean");
		expect(typeof result.remaining).toBe("number");
	});

	it("sets allowed=true when under limit", async () => {
		incrResult = 5;
		const limiter = createRateLimiter({
			windowSec: 60,
			max: 10,
			keyPrefix: "test",
		});
		const result = await limiter("127.0.0.1");
		expect(result.allowed).toBe(true);
		expect(result.remaining).toBe(5);
	});

	it("sets allowed=false when over limit", async () => {
		incrResult = 15;
		ttlResult = 30;
		const limiter = createRateLimiter({
			windowSec: 60,
			max: 10,
			keyPrefix: "test",
		});
		const result = await limiter("127.0.0.1");
		expect(result.allowed).toBe(false);
		expect(result.remaining).toBe(0);
		expect(result.retryAfter).toBe(30);
	});

	it("sets retryAfter to windowSec when ttl is negative", async () => {
		incrResult = 15;
		ttlResult = -1;
		const limiter = createRateLimiter({
			windowSec: 60,
			max: 10,
			keyPrefix: "test",
		});
		const result = await limiter("127.0.0.1");
		expect(result.allowed).toBe(false);
		expect(result.retryAfter).toBe(60);
	});

	it("calls incr and expire on first request", async () => {
		let incrCalled = false;
		let expireCalledWith: [string, number] | null = null;
		const trackingRedis = {
			incr: async (_key: string) => {
				incrCalled = true;
				return 1;
			},
			expire: async (key: string, secs: number) => {
				expireCalledWith = [key, secs];
				return 1;
			},
			ttl: async (_key: string) => 60,
		};
		const limiter = createRateLimiter(
			{ windowSec: 60, max: 10, keyPrefix: "test" },
			trackingRedis,
		);
		await limiter("127.0.0.1");
		expect(incrCalled).toBe(true);
		// biome-ignore lint/style/noNonNullAssertion: <test assertion after <toBeDefined>>
		expect(expireCalledWith![1]).toBe(60);
	});

	it("returns allowed=true with remaining=0 at exact limit", async () => {
		incrResult = 10;
		const limiter = createRateLimiter({
			windowSec: 60,
			max: 10,
			keyPrefix: "test",
		});
		const result = await limiter("127.0.0.1");
		expect(result.allowed).toBe(true);
		expect(result.remaining).toBe(0);
	});

	it("returns allowed=false on Redis error", async () => {
		const errorRedis = {
			incr: async () => {
				throw new Error("connection failed");
			},
			expire: async () => {
				throw new Error("connection failed");
			},
			ttl: async () => {
				throw new Error("connection failed");
			},
		};
		const limiter = createRateLimiter(
			{ windowSec: 60, max: 10, keyPrefix: "test" },
			errorRedis,
		);
		const result = await limiter("127.0.0.1");
		expect(result.allowed).toBe(false);
		expect(result.remaining).toBe(0);
		expect(result.retryAfter).toBe(60);
	});
});

describe("RateLimitResult shape", () => {
	it("result satisfies RateLimitResult interface", async () => {
		incrResult = 3;
		const limiter = createRateLimiter({
			windowSec: 60,
			max: 10,
			keyPrefix: "test",
		});
		const result = await limiter("127.0.0.1");
		const _check: RateLimitResult = result;
		expect(_check).toBeDefined();
	});

	it("rate limit result remaining is correct", async () => {
		incrResult = 7;
		const limiter = createRateLimiter({
			windowSec: 60,
			max: 10,
			keyPrefix: "test",
		});
		const result = await limiter("127.0.0.1");
		expect(result.remaining).toBe(3);
	});
});
