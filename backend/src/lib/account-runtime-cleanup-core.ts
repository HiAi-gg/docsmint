const YJS_DOCUMENT_PREFIX = "yjs:doc:";
const DOCUMENT_LIST_CACHE_PREFIX = "hiai-docs:cache:docs:list:";
const DOCUMENT_SINGLE_CACHE_PREFIX = "hiai-docs:cache:docs:single:";
const REEMBED_DEDUP_PREFIX = "hiai-docs:reembed:dedup:";
const EXTRACT_DONE_PREFIX = "hiai-docs:extract:done:";
const CLEANUP_SNAPSHOT_PREFIX = "hiai-docs:account-runtime-cleanup:snapshot:";
const REDIS_BATCH_SIZE = 100;
const MAX_IN_MEMORY_SNAPSHOTS = 128;

export type AccountRuntimeDocumentSnapshot = Readonly<{
	documentId: string;
	workspaceId: string | null;
}>;

export type AccountRuntimeCleanupRedis = Readonly<{
	get(key: string): Promise<string | null>;
	set(key: string, value: string, mode: "NX"): Promise<"OK" | null>;
	scan(
		cursor: string,
		match: "MATCH",
		pattern: string,
		count: "COUNT",
		countValue: number,
	): Promise<[string, string[]]>;
	del(...keys: string[]): Promise<number>;
	quit(): Promise<unknown>;
}>;

export type AccountRuntimeCleanup = Readonly<{
	removeCollaborationState(
		actorUserId: string,
		signal?: AbortSignal,
	): Promise<number>;
	clearAccountRedisState(
		actorUserId: string,
		signal?: AbortSignal,
	): Promise<number>;
	close(): Promise<void>;
}>;

type AccountRuntimeCleanupDependencies = Readonly<{
	redis: AccountRuntimeCleanupRedis;
	snapshotActorDocuments(
		actorUserId: string,
		signal?: AbortSignal,
	): Promise<readonly AccountRuntimeDocumentSnapshot[]>;
	closeDatabase(): Promise<void>;
}>;

function throwIfAborted(signal?: AbortSignal): void {
	signal?.throwIfAborted();
}

function escapeRedisGlob(value: string): string {
	return value.replaceAll("\\", "\\\\").replace(/([*?[\]])/g, "\\$1");
}

async function deleteExactKeys(
	redis: AccountRuntimeCleanupRedis,
	keys: Iterable<string>,
	signal?: AbortSignal,
): Promise<number> {
	const unique = [...new Set(keys)];
	let deleted = 0;
	for (let offset = 0; offset < unique.length; offset += REDIS_BATCH_SIZE) {
		throwIfAborted(signal);
		const batch = unique.slice(offset, offset + REDIS_BATCH_SIZE);
		if (batch.length > 0) deleted += await redis.del(...batch);
		throwIfAborted(signal);
	}
	return deleted;
}

/**
 * Delete keys selected only through an OSS-owned namespace pattern. Patterns
 * are deliberately prefix/suffix anchored; this helper must never receive an
 * unscoped wildcard or perform substring matching.
 */
async function deleteNamespacePattern(
	redis: AccountRuntimeCleanupRedis,
	pattern: string,
	signal?: AbortSignal,
): Promise<number> {
	let cursor = "0";
	let deleted = 0;
	do {
		throwIfAborted(signal);
		const [nextCursor, keys] = await redis.scan(
			cursor,
			"MATCH",
			pattern,
			"COUNT",
			REDIS_BATCH_SIZE,
		);
		throwIfAborted(signal);
		deleted += await deleteExactKeys(redis, keys, signal);
		cursor = nextCursor;
	} while (cursor !== "0");
	return deleted;
}

type PersistedSnapshot = Readonly<{
	version: 1;
	actorUserId: string;
	documents: readonly AccountRuntimeDocumentSnapshot[];
}>;

function snapshotKey(actorUserId: string): string {
	return `${CLEANUP_SNAPSHOT_PREFIX}${actorUserId}`;
}

function parseSnapshot(value: string, actorUserId: string): PersistedSnapshot {
	const parsed: unknown = JSON.parse(value);
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("version" in parsed) ||
		parsed.version !== 1 ||
		!("actorUserId" in parsed) ||
		parsed.actorUserId !== actorUserId ||
		!("documents" in parsed) ||
		!Array.isArray(parsed.documents)
	) {
		throw new Error("account_runtime_cleanup_snapshot_invalid");
	}
	const documents = parsed.documents.map((document: unknown) => {
		if (
			typeof document !== "object" ||
			document === null ||
			!("documentId" in document) ||
			typeof document.documentId !== "string" ||
			document.documentId.length === 0 ||
			!("workspaceId" in document) ||
			(document.workspaceId !== null &&
				typeof document.workspaceId !== "string")
		) {
			throw new Error("account_runtime_cleanup_snapshot_invalid");
		}
		return {
			documentId: document.documentId,
			workspaceId: document.workspaceId,
		};
	});
	return { version: 1, actorUserId, documents };
}

/**
 * Testable state machine behind the public URL-based runtime factory.
 * Dependency injection remains internal to the backend build and is not a
 * package export.
 */
export function createAccountRuntimeCleanupWithDependencies(
	dependencies: AccountRuntimeCleanupDependencies,
): AccountRuntimeCleanup {
	const snapshots = new Map<
		string,
		readonly AccountRuntimeDocumentSnapshot[]
	>();
	const capturingActors = new Set<string>();
	const clearingActors = new Set<string>();
	let closed = false;

	function requireOpen(): void {
		if (closed) throw new Error("account_runtime_cleanup_closed");
	}

	function cacheSnapshot(
		actorUserId: string,
		documents: readonly AccountRuntimeDocumentSnapshot[],
	): void {
		snapshots.delete(actorUserId);
		snapshots.set(actorUserId, documents);
		while (snapshots.size > MAX_IN_MEMORY_SNAPSHOTS) {
			const oldest = snapshots.keys().next().value;
			if (typeof oldest !== "string") break;
			snapshots.delete(oldest);
		}
	}

	async function loadDurableSnapshot(
		actorUserId: string,
		signal?: AbortSignal,
	): Promise<readonly AccountRuntimeDocumentSnapshot[] | null> {
		const cached = snapshots.get(actorUserId);
		if (cached) return cached;
		throwIfAborted(signal);
		const encoded = await dependencies.redis.get(snapshotKey(actorUserId));
		throwIfAborted(signal);
		if (encoded === null) return null;
		const persisted = parseSnapshot(encoded, actorUserId);
		cacheSnapshot(actorUserId, persisted.documents);
		return persisted.documents;
	}

	return {
		async removeCollaborationState(actorUserId, signal) {
			requireOpen();
			throwIfAborted(signal);
			if (capturingActors.has(actorUserId) || clearingActors.has(actorUserId)) {
				throw new Error("account_runtime_cleanup_snapshot_pending");
			}

			capturingActors.add(actorUserId);
			try {
				let snapshot = await loadDurableSnapshot(actorUserId, signal);
				if (!snapshot) {
					const documents = await dependencies.snapshotActorDocuments(
						actorUserId,
						signal,
					);
					throwIfAborted(signal);
					const candidate: PersistedSnapshot = {
						version: 1,
						actorUserId,
						documents: documents.map((document) => ({
							documentId: document.documentId,
							workspaceId: document.workspaceId,
						})),
					};
					const persisted = await dependencies.redis.set(
						snapshotKey(actorUserId),
						JSON.stringify(candidate),
						"NX",
					);
					throwIfAborted(signal);
					if (persisted === "OK") {
						snapshot = candidate.documents;
					} else {
						const winner = await dependencies.redis.get(
							snapshotKey(actorUserId),
						);
						throwIfAborted(signal);
						if (winner === null) {
							throw new Error("account_runtime_cleanup_snapshot_race");
						}
						snapshot = parseSnapshot(winner, actorUserId).documents;
					}
					cacheSnapshot(actorUserId, snapshot);
				}
				const deleted = await deleteExactKeys(
					dependencies.redis,
					snapshot.map(
						(document) => `${YJS_DOCUMENT_PREFIX}${document.documentId}`,
					),
					signal,
				);
				throwIfAborted(signal);
				return deleted;
			} finally {
				capturingActors.delete(actorUserId);
			}
		},

		async clearAccountRedisState(actorUserId, signal) {
			requireOpen();
			if (capturingActors.has(actorUserId)) {
				throw new Error("account_runtime_cleanup_snapshot_pending");
			}
			const snapshot = await loadDurableSnapshot(actorUserId, signal);
			if (!snapshot) return 0;
			clearingActors.add(actorUserId);
			try {
				throwIfAborted(signal);
				let deleted = await deleteNamespacePattern(
					dependencies.redis,
					`${DOCUMENT_LIST_CACHE_PREFIX}${escapeRedisGlob(actorUserId)}:*`,
					signal,
				);

				for (const document of snapshot) {
					throwIfAborted(signal);
					const escapedDocumentId = escapeRedisGlob(document.documentId);
					deleted += await deleteNamespacePattern(
						dependencies.redis,
						`${DOCUMENT_SINGLE_CACHE_PREFIX}*:${escapedDocumentId}`,
						signal,
					);
					deleted += await deleteExactKeys(
						dependencies.redis,
						[
							`${REEMBED_DEDUP_PREFIX}${document.documentId}`,
							...(document.workspaceId
								? [
										`${REEMBED_DEDUP_PREFIX}${document.workspaceId}:${document.documentId}`,
									]
								: []),
						],
						signal,
					);
					for (const dedupScope of [
						`${REEMBED_DEDUP_PREFIX}${escapedDocumentId}`,
						...(document.workspaceId
							? [
									`${REEMBED_DEDUP_PREFIX}${escapeRedisGlob(encodeURIComponent(document.workspaceId))}:${escapedDocumentId}`,
								]
							: []),
					]) {
						deleted += await deleteNamespacePattern(
							dependencies.redis,
							`${dedupScope}:*`,
							signal,
						);
					}
					deleted += await deleteNamespacePattern(
						dependencies.redis,
						`${EXTRACT_DONE_PREFIX}${escapedDocumentId}:*`,
						signal,
					);
					throwIfAborted(signal);
				}
				deleted += await deleteExactKeys(
					dependencies.redis,
					[snapshotKey(actorUserId)],
					signal,
				);
				snapshots.delete(actorUserId);
				return deleted;
			} finally {
				clearingActors.delete(actorUserId);
			}
		},

		async close() {
			if (closed) return;
			closed = true;
			snapshots.clear();
			capturingActors.clear();
			clearingActors.clear();
			await Promise.all([
				dependencies.redis.quit(),
				dependencies.closeDatabase(),
			]);
		},
	};
}
