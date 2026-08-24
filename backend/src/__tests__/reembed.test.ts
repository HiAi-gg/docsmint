/**
 * Tests for the reembed shared helper.
 *
 * Reembed is the single entry point used by every metadata mutation route
 * (tag rename/delete, folder rename/delete, category rename/delete, document
 * PATCH) to push documents back onto the embedding worker queue. The contract
 * we are locking down here:
 *
 *   1. Pure-logic dedup: a single call must collapse duplicate / null /
 *      empty / whitespace ids before touching Redis or the queue.
 *   2. Cross-call dedup: a second call with the same id within the Redis
 *      SET-NX TTL window must be a no-op (Redis short-circuits).
 *   3. Best-effort: a Redis failure must NOT throw out of `enqueueReembed`.
 *      If the dedup slot cannot be claimed (Redis unreachable), we err on
 *      the side of "go ahead and enqueue" so a Redis outage does not
 *      silently drop re-embed work.
 *   4. Return value: the integer return tells the caller how many docs
 *      actually hit the queue, NOT how many ids were passed in.
 *
 * The folder / category / tag domain helpers (`reembedDocsInFolder`,
 * `reembedDocsInCategory`, `reembedDocsByTag`) are integration-tested at the
 * route level via the existing `routes.documents.test.ts` harness. This file
 * focuses on the pure-logic dedup path so a regression here is caught
 * without standing up Postgres.
 *
 * `reembedDocsInFolderAdmin` (the operator-scope variant used by the admin
 * folder reindex endpoint) has its own smoke-test block below. The
 * owner_id-bypass behavior is the actual regression we want to catch - if
 * someone reverts the helper to call `reembedDocsInFolder(folderId, "")`
 * the unit test would still pass, so the deep regression coverage lives in
 * the route integration suite.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

// Mock the Redis module before importing reembed so the dedup helper sees
// our fake. We also mock `enqueueEmbedding` (the queue's actual push) so
// the test can count pushes without a real Redis instance.
const fakeRedis = {
	setCalls: [] as Array<{
		key: string;
		value: string;
		expireMode: string;
		ttl: number;
		nxFlag: string;
	}>,
	// Default: SET NX EX returns "OK" (slot claimed). Tests can override.
	nextResult: "OK" as string | null,
	set: mock(async function (
		this: unknown,
		key: string,
		value: string,
		expireMode: string,
		ttl: number,
		nxFlag: string,
	): Promise<string | null> {
		fakeRedis.setCalls.push({ key, value, expireMode, ttl, nxFlag });
		return fakeRedis.nextResult;
	}),
};

const defaultRedisSet = fakeRedis.set;

const fakeEnqueue = mock(
	async (
		_id: string,
		_source?: string,
		_workspaceId?: string,
		_options?: unknown,
	) => true,
);

const adminMockRows = [
	{ id: "admin-doc-1", title: "One", content: "body" },
	{ id: "admin-doc-2", title: "Two", content: "body" },
];

mock.module("../lib/redis", () => ({ redis: fakeRedis }));
mock.module("../lib/embedding-queue", () => ({
	enqueueEmbedding: fakeEnqueue,
}));
type DrainMetadataReembedOutboxPages = (
	operationId: string | undefined,
	pageSize: number,
	dependencies: {
		loadPage: (
			operationId: string | undefined,
			cursor: string | undefined,
			limit: number,
		) => Promise<
			Array<{
				id: string;
				documentId: string;
				ownerId: string;
				workspaceId?: string;
				revision: string;
			}>
		>;
		dispatch: (
			target: Readonly<{ id: string }>,
		) => Promise<"enqueued" | "deduplicated" | "failed">;
		acknowledge: (ids: readonly string[]) => Promise<void>;
	},
) => Promise<{ enqueued: number; completed: number; failed: number }>;
type ReembedOutboxTestModule = typeof import("../lib/reembed") & {
	drainMetadataReembedOutboxPagesWith: DrainMetadataReembedOutboxPages;
};
// Now safe to import the module under test.
const reembedModule = (await import(
	"../lib/reembed"
)) as ReembedOutboxTestModule;
const {
	drainMetadataReembedOutboxPagesWith,
	enqueueReembed,
	reembedDocumentAdminWith,
	reembedDocsInFolderAdminWith,
} = reembedModule;

afterEach(() => {
	fakeRedis.setCalls.length = 0;
	fakeRedis.nextResult = "OK";
	fakeRedis.set = defaultRedisSet;
	fakeEnqueue.mockClear();
});

describe("enqueueReembed pure-logic dedup", () => {
	test("filters out null, undefined, and empty strings", async () => {
		const ids = [
			"a",
			null as unknown as string,
			"",
			"b",
			undefined as unknown as string,
			"  ",
			"c",
		];
		const pushed = await enqueueReembed(ids);
		expect(pushed).toBe(3);
		expect(fakeEnqueue.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c"]);
	});

	test("collapses duplicate ids within a single call (Set dedup)", async () => {
		const pushed = await enqueueReembed(["a", "a", "b", "a", "b", "c"]);
		expect(pushed).toBe(3);
		expect(fakeEnqueue.mock.calls.length).toBe(3);
	});

	test("returns 0 for an empty input", async () => {
		const pushed = await enqueueReembed([]);
		expect(pushed).toBe(0);
		expect(fakeEnqueue.mock.calls.length).toBe(0);
	});

	test("returns 0 when every id is filtered out", async () => {
		const pushed = await enqueueReembed([null, undefined, "", "   "]);
		expect(pushed).toBe(0);
		expect(fakeEnqueue.mock.calls.length).toBe(0);
	});
});

describe("enqueueReembed Redis SET-NX dedup", () => {
	test("does not drop a newer content revision inside the debounce window", async () => {
		const claimed = new Set<string>();
		fakeRedis.set = mock(async (key: string) => {
			if (claimed.has(key)) return null;
			claimed.add(key);
			return "OK";
		});

		const first = await enqueueReembed(
			[{ id: "doc-1", revision: "revision-a" }],
			undefined,
			{ reason: "content", refreshMode: "incremental" },
		);
		const second = await enqueueReembed(
			[{ id: "doc-1", revision: "revision-b" }],
			undefined,
			{ reason: "content", refreshMode: "incremental" },
		);

		expect([first, second]).toEqual([1, 1]);
		expect(fakeEnqueue.mock.calls.map((call) => call[0])).toEqual([
			"doc-1",
			"doc-1",
		]);
	});

	test("does not collapse a full metadata refresh into content-only work", async () => {
		const claimed = new Set<string>();
		fakeRedis.set = mock(async (key: string) => {
			if (claimed.has(key)) return null;
			claimed.add(key);
			return "OK";
		});

		await enqueueReembed(
			[{ id: "doc-1", revision: "same-revision" }],
			undefined,
			{ reason: "content", refreshMode: "incremental" },
		);
		await enqueueReembed(
			[{ id: "doc-1", revision: "same-revision" }],
			undefined,
			{ reason: "metadata", refreshMode: "full" },
		);

		expect(fakeEnqueue).toHaveBeenCalledTimes(2);
		expect(fakeEnqueue.mock.calls[1]).toEqual([
			"doc-1",
			"interactive",
			undefined,
			{
				forceNewGeneration: true,
				refreshMode: "full",
				revision: "same-revision",
			},
		]);
	});

	test("explicit recovery bypasses debounce and forces a new generation", async () => {
		const pushed = await enqueueReembed(["doc-1"], undefined, {
			bypassDedup: true,
			forceNewGeneration: true,
			source: "reindex",
			reason: "reindex",
			refreshMode: "full",
		});

		expect(pushed).toBe(1);
		expect(fakeRedis.setCalls).toHaveLength(0);
		expect(fakeEnqueue).toHaveBeenCalledWith("doc-1", "reindex", undefined, {
			forceNewGeneration: true,
			refreshMode: "full",
		});
	});

	test("does not report a push when the durable enqueue fails", async () => {
		fakeEnqueue.mockResolvedValueOnce(false);
		expect(await enqueueReembed(["doc-1"])).toBe(0);
	});

	test("uses SET key value EX <ttl> NX", async () => {
		await enqueueReembed(["doc-1"]);
		expect(fakeRedis.setCalls.length).toBe(1);
		const call = fakeRedis.setCalls[0];
		expect(call?.key).toBe("hiai-docs:reembed:dedup:doc-1");
		expect(call?.value).toBe("1");
		expect(call?.expireMode).toBe("EX");
		expect(call?.ttl).toBe(5);
		expect(call?.nxFlag).toBe("NX");
	});

	test("skips the enqueue when Redis reports the slot was already claimed", async () => {
		fakeRedis.nextResult = null; // SET ... NX returns null when key exists
		const pushed = await enqueueReembed(["doc-1", "doc-2"]);
		// Both attempts at slot claim returned null -> 0 actual pushes
		expect(pushed).toBe(0);
		expect(fakeEnqueue.mock.calls.length).toBe(0);
	});

	test("counts pushed ids only, NOT attempted slot claims", async () => {
		// doc-1 wins slot (OK), doc-2 loses (null), doc-3 wins (OK).
		const results = ["OK", null, "OK"];
		let i = 0;
		fakeRedis.set = mock(async () => results[i++] ?? null);
		const pushed = await enqueueReembed(["doc-1", "doc-2", "doc-3"]);
		expect(pushed).toBe(2);
		expect(fakeEnqueue.mock.calls.map((c) => c[0])).toEqual(["doc-1", "doc-3"]);
	});
});

describe("enqueueReembed best-effort on Redis failure", () => {
	test("proceeds with the enqueue when Redis SET throws (Redis down)", async () => {
		fakeRedis.set = mock(async () => {
			throw new Error("ECONNREFUSED");
		});
		const pushed = await enqueueReembed(["doc-1", "doc-2"]);
		// Both should still be enqueued - we err on the side of doing the work
		// rather than silently dropping re-embed work on a transient Redis blip.
		expect(pushed).toBe(2);
		expect(fakeEnqueue.mock.calls.length).toBe(2);
	});
});

describe("durable metadata re-embed outbox paging", () => {
	test("never buffers more than one configured page and retains failed rows", async () => {
		const targetCount = 10_003;
		const pageSize = 37;
		const observedPageSizes: number[] = [];
		const acknowledged: string[] = [];
		const result = await drainMetadataReembedOutboxPagesWith(
			"operation",
			pageSize,
			{
				loadPage: async (_operationId, cursor, limit) => {
					const start = cursor ? Number(cursor.slice("outbox-".length)) + 1 : 0;
					const page = Array.from(
						{ length: Math.min(limit, targetCount - start) },
						(_, offset) => {
							const index = start + offset;
							return {
								id: `outbox-${index}`,
								documentId: `doc-${index}`,
								ownerId: "owner",
								revision: `revision-${index}`,
							};
						},
					);
					observedPageSizes.push(page.length);
					return page;
				},
				dispatch: async ({ id }) => {
					if (id === "outbox-2") return "failed";
					if (id === "outbox-4") return "deduplicated";
					return "enqueued";
				},
				acknowledge: async (ids) => {
					acknowledged.push(...ids);
				},
			},
		);

		expect(Math.max(...observedPageSizes)).toBe(pageSize);
		expect(observedPageSizes).toHaveLength(Math.ceil(targetCount / pageSize));
		expect(result).toEqual({
			enqueued: targetCount - 2,
			completed: targetCount - 1,
			failed: 1,
		});
		expect(acknowledged).not.toContain("outbox-2");
		expect(acknowledged).toContain("outbox-4");
	});
});

describe("reembedDocsInFolderAdmin (operator-scope reindex)", () => {
	test("preserves workspace placement for a single admin reindex", async () => {
		const loadTarget = mock(async () => ({
			id: "workspace-doc",
			workspaceId: "workspace-1",
		}));
		const result = await reembedDocumentAdminWith("workspace-doc", loadTarget);

		expect(result).toEqual({ found: true, enqueued: 1 });
		expect(fakeEnqueue).toHaveBeenCalledWith(
			"workspace-doc",
			"reindex",
			"workspace-1",
			{ forceNewGeneration: true, refreshMode: "full" },
		);
	});

	test("returns the docs the db layer hands back, bypassing owner_id", async () => {
		// Smoke test: the helper takes only a folderId (no ownerId argument),
		// reads from the db, and pushes the returned ids through the dedup
		// path. The pre-fix code path (admin route passing "" as ownerId to
		// the user-scoped helper) would have returned 0 instead of 2 here.
		const loadRows = mock(
			(_folderId: string, cursor: string | undefined, _limit: number) =>
				Promise.resolve(cursor ? [] : adminMockRows),
		);
		const pushed = await reembedDocsInFolderAdminWith("folder-x", loadRows);

		expect(pushed).toBe(2);
		expect(fakeEnqueue.mock.calls.map((c) => c[0])).toEqual([
			"admin-doc-1",
			"admin-doc-2",
		]);
		expect(loadRows).toHaveBeenCalledTimes(1);
		expect(loadRows.mock.calls[0]?.[0]).toBe("folder-x");
	});

	test("returns 0 when the db returns no rows for the folder", async () => {
		const pushed = await reembedDocsInFolderAdminWith(
			"empty-folder",
			async () => [],
		);

		expect(pushed).toBe(0);
		expect(fakeEnqueue.mock.calls.length).toBe(0);
	});
});
