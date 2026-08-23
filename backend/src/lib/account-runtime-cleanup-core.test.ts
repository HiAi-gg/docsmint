import { describe, expect, test } from "bun:test";
import {
	type AccountRuntimeCleanupRedis,
	createAccountRuntimeCleanupWithDependencies,
} from "./account-runtime-cleanup-core";

type ScanPage = readonly [cursor: string, keys: string[]];

class FakeRedis implements AccountRuntimeCleanupRedis {
	readonly deleted: string[][] = [];
	readonly scans: string[] = [];
	quitCalls = 0;
	private readonly pages = new Map<string, ScanPage[]>();
	private readonly store: Map<string, string>;
	private failDelete = false;

	constructor(store = new Map<string, string>()) {
		this.store = store;
	}

	seed(...keys: string[]): void {
		for (const key of keys) this.store.set(key, "value");
	}

	failNextDelete(): void {
		this.failDelete = true;
	}

	setPages(pattern: string, pages: ScanPage[]): void {
		this.pages.set(pattern, pages);
		for (const [, keys] of pages) this.seed(...keys);
	}

	async get(key: string): Promise<string | null> {
		return this.store.get(key) ?? null;
	}

	async set(key: string, value: string, mode?: "NX"): Promise<"OK" | null> {
		if (mode === "NX" && this.store.has(key)) return null;
		this.store.set(key, value);
		return "OK";
	}

	async scan(
		_cursor: string,
		_match: "MATCH",
		pattern: string,
		_count: "COUNT",
		_countValue: number,
	): Promise<[string, string[]]> {
		this.scans.push(pattern);
		const configured = this.pages.get(pattern)?.shift();
		const page =
			configured ??
			([
				"0",
				[...this.store.keys()].filter((key) => matches(pattern, key)),
			] as const);
		return [page[0], [...page[1]]];
	}

	async del(...keys: string[]): Promise<number> {
		if (this.failDelete) {
			this.failDelete = false;
			throw new Error("redis_delete_failed");
		}
		this.deleted.push(keys);
		let count = 0;
		for (const key of keys) {
			if (this.store.delete(key)) count += 1;
		}
		return count;
	}

	async quit(): Promise<"OK"> {
		this.quitCalls += 1;
		return "OK";
	}
}

function matches(pattern: string, key: string): boolean {
	let source = "^";
	let escaped = false;
	for (const character of pattern) {
		if (escaped) {
			source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			escaped = false;
		} else if (character === "\\") {
			escaped = true;
		} else if (character === "*") {
			source += ".*";
		} else if (character === "?") {
			source += ".";
		} else {
			source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`${source}$`).test(key);
}

function flatten(redis: FakeRedis): string[] {
	return redis.deleted.flat();
}

describe("account runtime cleanup core", () => {
	test("owns every OSS Redis namespace and never deletes another actor list", async () => {
		const redis = new FakeRedis();
		const actor = "11111111-1111-4111-8111-111111111111";
		const other = "22222222-2222-4222-8222-222222222222";
		const personalDoc = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const sharedDoc = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		const workspace = "workspace-1";
		redis.seed(
			`yjs:doc:${personalDoc}`,
			`yjs:doc:${sharedDoc}`,
			`hiai-docs:reembed:dedup:${personalDoc}`,
			`hiai-docs:reembed:dedup:${personalDoc}:rev-a:incremental:content`,
			`hiai-docs:reembed:dedup:${sharedDoc}`,
			`hiai-docs:reembed:dedup:${workspace}:${sharedDoc}`,
			`hiai-docs:reembed:dedup:${workspace}:${sharedDoc}:rev-b:full:metadata`,
		);
		redis.setPages(`hiai-docs:cache:docs:list:${actor}:*`, [
			[
				"0",
				[
					`hiai-docs:cache:docs:list:${actor}:p:1:l:20`,
					`hiai-docs:cache:docs:list:${actor}:w:${workspace}:p:1:l:20`,
				],
			],
		]);
		redis.setPages(`hiai-docs:cache:docs:single:*:${personalDoc}`, [
			[
				"0",
				[
					`hiai-docs:cache:docs:single:${actor}:${personalDoc}`,
					`hiai-docs:cache:docs:single:${other}:${personalDoc}`,
				],
			],
		]);
		redis.setPages(`hiai-docs:cache:docs:single:*:${sharedDoc}`, [
			[
				"0",
				[
					`hiai-docs:cache:docs:single:${actor}:w:${workspace}:${sharedDoc}`,
					`hiai-docs:cache:docs:single:${other}:w:${workspace}:${sharedDoc}`,
				],
			],
		]);
		redis.setPages(`hiai-docs:extract:done:${personalDoc}:*`, [
			["0", [`hiai-docs:extract:done:${personalDoc}:0:hash-a`]],
		]);
		redis.setPages(`hiai-docs:reembed:dedup:${personalDoc}:*`, [
			[
				"0",
				[`hiai-docs:reembed:dedup:${personalDoc}:rev-a:incremental:content`],
			],
		]);
		redis.setPages(`hiai-docs:reembed:dedup:${workspace}:${sharedDoc}:*`, [
			[
				"0",
				[
					`hiai-docs:reembed:dedup:${workspace}:${sharedDoc}:rev-b:full:metadata`,
				],
			],
		]);
		redis.setPages(`hiai-docs:extract:done:${sharedDoc}:*`, [
			["0", [`hiai-docs:extract:done:${sharedDoc}:3:hash-b`]],
		]);
		let databaseCloseCalls = 0;
		const cleanup = createAccountRuntimeCleanupWithDependencies({
			redis,
			snapshotActorDocuments: async (actorUserId) => {
				expect(actorUserId).toBe(actor);
				return [
					{ documentId: personalDoc, workspaceId: null },
					{ documentId: sharedDoc, workspaceId: workspace },
				];
			},
			closeDatabase: async () => {
				databaseCloseCalls += 1;
			},
		});

		expect(await cleanup.removeCollaborationState(actor)).toBe(2);
		expect(flatten(redis)).toEqual([
			`yjs:doc:${personalDoc}`,
			`yjs:doc:${sharedDoc}`,
		]);

		expect(await cleanup.clearAccountRedisState(actor)).toBe(14);
		const deleted = flatten(redis);
		expect(deleted).toContain(`hiai-docs:cache:docs:list:${actor}:p:1:l:20`);
		expect(deleted).toContain(
			`hiai-docs:cache:docs:list:${actor}:w:${workspace}:p:1:l:20`,
		);
		expect(deleted).not.toContain(
			`hiai-docs:cache:docs:list:${other}:p:1:l:20`,
		);
		expect(deleted).toContain(
			`hiai-docs:cache:docs:single:${other}:${personalDoc}`,
		);
		expect(deleted).toContain(
			`hiai-docs:cache:docs:single:${other}:w:${workspace}:${sharedDoc}`,
		);
		expect(deleted).toContain(`hiai-docs:reembed:dedup:${personalDoc}`);
		expect(deleted).toContain(
			`hiai-docs:reembed:dedup:${personalDoc}:rev-a:incremental:content`,
		);
		expect(deleted).toContain(`hiai-docs:reembed:dedup:${sharedDoc}`);
		expect(deleted).toContain(
			`hiai-docs:reembed:dedup:${workspace}:${sharedDoc}`,
		);
		expect(deleted).toContain(
			`hiai-docs:reembed:dedup:${workspace}:${sharedDoc}:rev-b:full:metadata`,
		);
		expect(deleted).toContain(`hiai-docs:extract:done:${personalDoc}:0:hash-a`);
		expect(deleted).toContain(`hiai-docs:extract:done:${sharedDoc}:3:hash-b`);
		expect(redis.scans).toEqual([
			`hiai-docs:cache:docs:list:${actor}:*`,
			`hiai-docs:cache:docs:single:*:${personalDoc}`,
			`hiai-docs:reembed:dedup:${personalDoc}:*`,
			`hiai-docs:extract:done:${personalDoc}:*`,
			`hiai-docs:cache:docs:single:*:${sharedDoc}`,
			`hiai-docs:reembed:dedup:${sharedDoc}:*`,
			`hiai-docs:reembed:dedup:${workspace}:${sharedDoc}:*`,
			`hiai-docs:extract:done:${sharedDoc}:*`,
		]);

		await cleanup.close();
		await cleanup.close();
		expect(redis.quitCalls).toBe(1);
		expect(databaseCloseCalls).toBe(1);
	});

	test("consumes a snapshot once and subsequent clear is idempotent", async () => {
		const redis = new FakeRedis();
		const cleanup = createAccountRuntimeCleanupWithDependencies({
			redis,
			snapshotActorDocuments: async () => [
				{
					documentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
					workspaceId: null,
				},
			],
			closeDatabase: async () => {},
		});
		await cleanup.removeCollaborationState(
			"11111111-1111-4111-8111-111111111111",
		);
		const firstCount = await cleanup.clearAccountRedisState(
			"11111111-1111-4111-8111-111111111111",
		);
		expect(firstCount).toBeGreaterThan(0);
		const deleteCallCount = redis.deleted.length;
		const scanCallCount = redis.scans.length;
		expect(
			await cleanup.clearAccountRedisState(
				"11111111-1111-4111-8111-111111111111",
			),
		).toBe(0);
		expect(redis.deleted).toHaveLength(deleteCallCount);
		expect(redis.scans).toHaveLength(scanCallCount);
	});

	test("checks AbortSignal around Redis batches and retains the durable snapshot for retry", async () => {
		const redis = new FakeRedis();
		const actor = "11111111-1111-4111-8111-111111111111";
		const documentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const cleanup = createAccountRuntimeCleanupWithDependencies({
			redis,
			snapshotActorDocuments: async () => [{ documentId, workspaceId: null }],
			closeDatabase: async () => {},
		});
		await cleanup.removeCollaborationState(actor);
		const controller = new AbortController();
		controller.abort(new Error("lease_lost"));
		await expect(
			cleanup.clearAccountRedisState(actor, controller.signal),
		).rejects.toThrow("lease_lost");
		expect(await cleanup.clearAccountRedisState(actor)).toBeGreaterThan(0);
		expect(await cleanup.clearAccountRedisState(actor)).toBe(0);
	});

	test("reuses a pending durable snapshot, survives restart, and closes idempotently", async () => {
		const actor = "11111111-1111-4111-8111-111111111111";
		const store = new Map<string, string>();
		const redis = new FakeRedis(store);
		const documentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		redis.seed(`yjs:doc:${documentId}`);
		let snapshots = 0;
		const dependencies = {
			redis,
			snapshotActorDocuments: async () => {
				snapshots += 1;
				return [{ documentId, workspaceId: null }];
			},
			closeDatabase: async () => {},
		};
		const cleanup = createAccountRuntimeCleanupWithDependencies(dependencies);
		expect(await cleanup.removeCollaborationState(actor)).toBe(1);
		expect(await cleanup.removeCollaborationState(actor)).toBe(0);
		expect(snapshots).toBe(1);
		await cleanup.close();
		await expect(cleanup.clearAccountRedisState(actor)).rejects.toThrow(
			"account_runtime_cleanup_closed",
		);

		const replacement = createAccountRuntimeCleanupWithDependencies({
			...dependencies,
			redis: new FakeRedis(store),
		});
		expect(await replacement.clearAccountRedisState(actor)).toBe(1);
		expect(await replacement.clearAccountRedisState(actor)).toBe(0);
		await replacement.close();
	});

	test("retains the durable snapshot after a Redis failure and resumes after restart", async () => {
		const actor = "11111111-1111-4111-8111-111111111111";
		const documentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const store = new Map<string, string>();
		const redis = new FakeRedis(store);
		redis.seed(
			`yjs:doc:${documentId}`,
			`hiai-docs:reembed:dedup:${documentId}`,
		);
		let snapshots = 0;
		const cleanup = createAccountRuntimeCleanupWithDependencies({
			redis,
			snapshotActorDocuments: async () => {
				snapshots += 1;
				return [{ documentId, workspaceId: null }];
			},
			closeDatabase: async () => {},
		});
		await cleanup.removeCollaborationState(actor);
		redis.failNextDelete();
		await expect(cleanup.clearAccountRedisState(actor)).rejects.toThrow(
			"redis_delete_failed",
		);
		await cleanup.close();

		const replacement = createAccountRuntimeCleanupWithDependencies({
			redis: new FakeRedis(store),
			snapshotActorDocuments: async () => {
				snapshots += 1;
				return [];
			},
			closeDatabase: async () => {},
		});
		expect(await replacement.clearAccountRedisState(actor)).toBe(2);
		expect(await replacement.clearAccountRedisState(actor)).toBe(0);
		expect(snapshots).toBe(1);
		await replacement.close();
	});
});
