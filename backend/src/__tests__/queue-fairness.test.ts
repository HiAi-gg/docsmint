import { describe, expect, test } from "bun:test";
import {
	createOwnerFairScheduler,
	type RedisLeaseClient,
	withOwnerSlot,
} from "../queue/fair-scheduler";

class FakeLeaseRedis implements RedisLeaseClient {
	private readonly leases = new Map<string, Map<string, number>>();

	async eval(_script: string, _keys: number, ...args: Array<string | number>) {
		const key = String(args[0]);
		const isAcquire = args.length === 5;
		const entries = this.leases.get(key) ?? new Map<string, number>();
		this.leases.set(key, entries);
		if (!isAcquire) return entries.delete(String(args[1])) ? 1 : 0;
		const now = Number(args[1]);
		for (const [id, expiry] of entries) if (expiry <= now) entries.delete(id);
		if (entries.size >= Number(args[3])) return 0;
		entries.set(String(args[4]), Number(args[2]));
		return 1;
	}
}

describe("owner fair scheduler", () => {
	test("production wrapper always acquires and releases around stage work", async () => {
		const events: string[] = [];
		const result = await withOwnerSlot(
			"owner-a",
			"embed",
			async () => {
				events.push("work");
				return "done";
			},
			async (ownerId, stage) => {
				events.push(`acquire:${ownerId}:${stage}`);
				return async () => {
					events.push("release");
				};
			},
		);
		expect(result).toBe("done");
		expect(events).toEqual(["acquire:owner-a:embed", "work", "release"]);
	});

	test("one saturated owner cannot block another owner", async () => {
		const acquire = createOwnerFairScheduler(new FakeLeaseRedis(), {
			limits: { embed: 2 },
			pollIntervalMs: 1,
		});
		const releaseA1 = await acquire("owner-a", "embed");
		const releaseA2 = await acquire("owner-a", "embed");
		let thirdAStarted = false;
		const thirdA = acquire("owner-a", "embed").then((release) => {
			thirdAStarted = true;
			return release;
		});
		await Bun.sleep(3);
		expect(thirdAStarted).toBe(false);
		const releaseB = await acquire("owner-b", "embed");
		await releaseB();
		await releaseA1();
		const releaseA3 = await thirdA;
		expect(thirdAStarted).toBe(true);
		await Promise.all([releaseA2(), releaseA3()]);
	});

	test("expired leases are reclaimed and release is idempotent", async () => {
		const acquire = createOwnerFairScheduler(new FakeLeaseRedis(), {
			limits: { graph: 1 },
			leaseTtlMs: 2,
			pollIntervalMs: 1,
		});
		const abandoned = await acquire("owner-a", "graph");
		await Bun.sleep(4);
		const replacement = await acquire("owner-a", "graph");
		await abandoned();
		await abandoned();
		await replacement();
	});

	test("aborts a waiting acquisition", async () => {
		const acquire = createOwnerFairScheduler(new FakeLeaseRedis(), {
			limits: { graph: 1 },
			pollIntervalMs: 2,
		});
		const release = await acquire("owner-a", "graph");
		const controller = new AbortController();
		const waiting = acquire("owner-a", "graph", controller.signal);
		controller.abort();
		await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
		await release();
	});
});
