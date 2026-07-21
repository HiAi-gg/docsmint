import type {
	AssertPurgeAllowed,
	LifecycleHostStep,
	UserDataLifecycle,
} from "./lifecycle";

/**
 * Server-only external effects required by the durable OSS lifecycle saga.
 * Implementations must perform real deletion work; the runtime deliberately
 * has no permissive defaults for queues, object storage, Redis, collaboration,
 * or graph state.
 */
export type LifecycleRuntimeAdapters = Readonly<{
	verifyPurgeFence: (
		context: Parameters<AssertPurgeAllowed>[0],
		fenceToken: string,
	) => Promise<void>;
	deleteObjects: (
		keys: readonly string[],
		signal?: AbortSignal,
	) => Promise<number>;
	cancelAccountJobs: (
		actorUserId: string,
		signal?: AbortSignal,
	) => Promise<number>;
	clearAccountRedisState: (
		actorUserId: string,
		signal?: AbortSignal,
	) => Promise<number>;
	removeCollaborationState: (
		actorUserId: string,
		signal?: AbortSignal,
	) => Promise<number>;
	removeGraphState: (
		documentIds: readonly string[],
		signal?: AbortSignal,
	) => Promise<number>;
}>;

/**
 * Host-owned request/RLS transaction executor. TTransaction is intentionally
 * generic so a consumer can retain the exact Drizzle transaction type without
 * this public contract importing its database singleton.
 */
export type LifecycleScopedDatabaseExecutor<TTransaction = unknown> = Readonly<{
	withActorTransaction<T>(
		actorUserId: string,
		operation: (transaction: TTransaction) => Promise<T>,
	): Promise<T>;
}>;

export type PersistentLifecycleRuntimeOptions<TTransaction = unknown> = Readonly<{
	runtime: LifecycleRuntimeAdapters;
	database: LifecycleScopedDatabaseExecutor<TTransaction>;
	assertPurgeAllowed: AssertPurgeAllowed;
	hostSteps?: readonly LifecycleHostStep[];
}>;

/**
 * Creates the concrete durable PostgreSQL lifecycle saga shipped by DocsMint.
 * The JavaScript implementation is bundled from the OSS backend at build time;
 * this source file is the stable public declaration surface.
 */
export declare function createPersistentLifecycleRuntime<TTransaction = unknown>(
	options: PersistentLifecycleRuntimeOptions<TTransaction>,
): UserDataLifecycle;
