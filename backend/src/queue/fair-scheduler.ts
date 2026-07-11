import type { PipelineStage } from "./contracts";

export type Release = () => Promise<void>;

export interface RedisLeaseClient {
	eval(
		script: string,
		numberOfKeys: number,
		...args: Array<string | number>
	): Promise<unknown>;
}

export interface OwnerFairnessOptions {
	limits?: Partial<Record<PipelineStage, number>>;
	leaseTtlMs?: number;
	pollIntervalMs?: number;
	keyPrefix?: string;
}

export const DEFAULT_OWNER_STAGE_LIMITS = {
	prepare: 2,
	embed: 4,
	graph: 1,
	summarize: 1,
	finalize: 2,
} as const satisfies Record<PipelineStage, number>;

const ACQUIRE_LEASE_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local expires = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local leaseId = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
if redis.call('ZCARD', key) >= limit then return 0 end
redis.call('ZADD', key, expires, leaseId)
redis.call('PEXPIRE', key, math.max(1, expires - now))
return 1
`;

const RELEASE_LEASE_SCRIPT = `
return redis.call('ZREM', KEYS[1], ARGV[1])
`;

function abortError(): DOMException {
	return new DOMException("Owner slot acquisition aborted", "AbortError");
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortError());
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(abortError());
			},
			{ once: true },
		);
	});
}

export function createOwnerFairScheduler(
	client: RedisLeaseClient,
	options: OwnerFairnessOptions = {},
) {
	const limits = { ...DEFAULT_OWNER_STAGE_LIMITS, ...options.limits };
	const leaseTtlMs = options.leaseTtlMs ?? 60_000;
	const pollIntervalMs = options.pollIntervalMs ?? 25;
	const keyPrefix = options.keyPrefix ?? "hiai-docs:owner-slots:v1";

	return async function acquire(
		ownerId: string,
		stage: PipelineStage,
		signal?: AbortSignal,
	): Promise<Release> {
		const limit = limits[stage];
		if (!Number.isInteger(limit) || limit < 1) {
			throw new Error(`Invalid owner concurrency limit for ${stage}`);
		}
		const leaseId = crypto.randomUUID();
		const key = `${keyPrefix}:${stage}:${ownerId}`;
		while (true) {
			if (signal?.aborted) throw abortError();
			const now = Date.now();
			const acquired = await client.eval(
				ACQUIRE_LEASE_SCRIPT,
				1,
				key,
				now,
				now + leaseTtlMs,
				limit,
				leaseId,
			);
			if (Number(acquired) === 1) {
				let released = false;
				return async () => {
					if (released) return;
					released = true;
					await client.eval(RELEASE_LEASE_SCRIPT, 1, key, leaseId);
				};
			}
			await wait(pollIntervalMs, signal);
		}
	};
}

let defaultAcquire: ReturnType<typeof createOwnerFairScheduler> | undefined;

export async function acquireOwnerSlot(
	ownerId: string,
	stage: PipelineStage,
	signal?: AbortSignal,
): Promise<Release> {
	if (!defaultAcquire) {
		const { redis } = await import("../lib/redis");
		defaultAcquire = createOwnerFairScheduler(redis);
	}
	return defaultAcquire(ownerId, stage, signal);
}
