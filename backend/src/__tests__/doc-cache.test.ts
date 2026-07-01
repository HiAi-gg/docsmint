/**
 * Unit tests for `backend/src/lib/doc-cache.ts` (A4 cross-tenant fix).
 *
 * Covers:
 *   - `docSingleKey(docId, userId)` includes the userId in the key so
 *     User A's cached fetch is keyed separately from User B's.
 *   - `invalidateDocCache(docId)` deletes every per-user variant via
 *     SCAN, even when the write-side caller does not know which user
 *     has a cached copy.
 *   - `cacheGetOrSet` reads from the user-scoped key only, never from
 *     a foreign user's entry.
 *
 * The harness is a hand-rolled in-memory store keyed by `set` calls,
 * which lets us assert the exact Redis keys the module touches
 * without standing up a real Redis instance.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

// The doc-cache module reads its redis binding at import time, so we
// must install the mock BEFORE the import statement runs. Using a
// dynamic import inside `beforeAll` and stashing the exports on a
// holder lets us wire mocks first.
//
// Bun's `mock.module` is hoisted, but to keep the import shape
// predictable we still do a single dynamic import after declaring the
// mocks in module top-level scope.

const fakeStore: Map<string, string> = new Map();
const fakeScanCalls: Array<{ cursor: string; pattern: string }> = [];
const fakeDelCalls: string[][] = [];

function resetFakeStore(): void {
	fakeStore.clear();
	fakeScanCalls.length = 0;
	fakeDelCalls.length = 0;
}

mock.module("../lib/redis", () => ({
	redis: {
		get: async (key: string) => fakeStore.get(key) ?? null,
		set: async (key: string, value: string, ..._rest: unknown[]) => {
			fakeStore.set(key, value);
			return "OK";
		},
		del: async (...keys: string[]) => {
			fakeDelCalls.push(keys);
			let count = 0;
			for (const key of keys) {
				if (fakeStore.delete(key)) count++;
			}
			return count;
		},
		scan: async (
			cursor: string,
			_match: string,
			pattern: string,
			_count: string,
			_countN: number,
		) => {
			fakeScanCalls.push({ cursor, pattern });
			const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
			const regex = new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
			const matches = [...fakeStore.keys()].filter((k) => regex.test(k));
			// Single-shot iteration — return cursor "0" immediately so the
			// do/while loop in the module terminates after one round.
			return ["0", matches];
		},
	},
}));

mock.module("../lib/logger", () => ({
	logger: {
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
		fatal: () => {},
		trace: () => {},
		child: () => ({
			info: () => {},
			warn: () => {},
			error: () => {},
			debug: () => {},
		}),
	},
	createChildLogger: () => ({
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
	}),
}));

const mod = await import("../lib/doc-cache");

describe("docSingleKey", () => {
	it("includes userId in the key so two users get distinct entries", () => {
		const keyA = mod.docSingleKey("doc-1", "user-A");
		const keyB = mod.docSingleKey("doc-1", "user-B");
		expect(keyA).not.toBe(keyB);
		expect(keyA).toContain("user-A");
		expect(keyB).toContain("user-B");
		expect(keyA.endsWith(":doc-1")).toBe(true);
		expect(keyB.endsWith(":doc-1")).toBe(true);
	});

	it("keeps the single-prefix namespace", () => {
		expect(mod.docSingleKey("doc-1", "user-A")).toMatch(
			/^hiai-docs:cache:docs:single:/,
		);
	});
});

describe("invalidateDocCache", () => {
	beforeEach(() => {
		resetFakeStore();
	});

	it("deletes every per-user variant of a single doc", async () => {
		const docId = "doc-42";
		fakeStore.set(
			mod.docSingleKey(docId, "user-A"),
			JSON.stringify({ id: docId, owner: "user-A" }),
		);
		fakeStore.set(
			mod.docSingleKey(docId, "user-B"),
			JSON.stringify({ id: docId, owner: "user-B" }),
		);
		// A list-cache key for the same userId + docId substring must
		// NOT match — the wildcard pattern must be anchored on the
		// `:${docId}` suffix to avoid clobbering unrelated entries.
		fakeStore.set(`hiai-docs:cache:docs:list:user-A:p:1:l:20`, "should remain");
		// An unrelated doc entirely must remain too.
		fakeStore.set(
			mod.docSingleKey("doc-other", "user-A"),
			JSON.stringify({ id: "doc-other" }),
		);

		await mod.invalidateDocCache(docId);

		expect(fakeStore.has(mod.docSingleKey(docId, "user-A"))).toBe(false);
		expect(fakeStore.has(mod.docSingleKey(docId, "user-B"))).toBe(false);
		expect(fakeStore.has("hiai-docs:cache:docs:list:user-A:p:1:l:20")).toBe(
			true,
		);
		expect(fakeStore.has(mod.docSingleKey("doc-other", "user-A"))).toBe(true);
	});

	it("scans with the single-prefix pattern", async () => {
		await mod.invalidateDocCache("doc-99");
		expect(fakeScanCalls.length).toBeGreaterThan(0);
		for (const call of fakeScanCalls) {
			expect(call.pattern).toBe("hiai-docs:cache:docs:single:*:doc-99");
		}
	});

	it("is a no-op when no matching keys exist", async () => {
		fakeStore.set("some:other:key", "value");
		await expect(
			mod.invalidateDocCache("missing-doc"),
		).resolves.toBeUndefined();
		expect(fakeDelCalls.length).toBe(0);
		expect(fakeStore.has("some:other:key")).toBe(true);
	});
});

describe("cacheGetOrSet with user-scoped keys", () => {
	beforeEach(() => {
		resetFakeStore();
	});

	it("stores a fetch under user A's key, not user B's", async () => {
		const docId = "doc-shared";
		const valueA = { id: docId, ownerId: "user-A", title: "Mine" };
		const computed = await mod.cacheGetOrSet(
			mod.docSingleKey(docId, "user-A"),
			60,
			async () => valueA,
		);
		expect(computed).toEqual(valueA);

		const storedA = fakeStore.get(mod.docSingleKey(docId, "user-A"));
		expect(storedA).toBe(JSON.stringify(valueA));
		// No cross-pollination: user B's slot must be empty.
		expect(fakeStore.get(mod.docSingleKey(docId, "user-B"))).toBeUndefined();
	});

	it("returns the cached value when present under the same userId", async () => {
		const docId = "doc-cached";
		fakeStore.set(
			mod.docSingleKey(docId, "user-A"),
			JSON.stringify({ id: docId, ownerId: "user-A" }),
		);

		let computedCalled = false;
		const result = await mod.cacheGetOrSet(
			mod.docSingleKey(docId, "user-A"),
			60,
			async () => {
				computedCalled = true;
				return { id: docId, ownerId: "user-A" };
			},
		);

		expect(computedCalled).toBe(false);
		expect(result).toEqual({ id: docId, ownerId: "user-A" });
	});
});
