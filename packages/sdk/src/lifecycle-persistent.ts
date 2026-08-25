import {
	type AssertPurgeAllowed,
	createUserDataLifecycle,
	type ExportUserDataContext,
	type LifecycleHostStep,
	orderLifecycleHostSteps,
	type PurgeUserDataContext,
	type PurgeUserDataResult,
	type UserDataExportRecord,
	type UserDataLifecycle,
	type UserDataLifecycleAdapter,
} from "./lifecycle";

/**
 * Minimal transaction boundary required by the durable lifecycle runtime.
 * Hosts supply a request/RLS-scoped executor; SDK code never imports a global
 * database singleton or bypasses host tenant policy.
 */
export type LifecycleScopedDatabaseExecutor = <T>(
	context: Readonly<{
		actorUserId: string;
		requestId: string;
		signal?: AbortSignal;
	}>,
	operation: () => Promise<T>,
) => Promise<T>;

/**
 * Public persistent lifecycle composition contract.  The OSS persistence
 * saga is supplied by the backend runtime; external hosts attach their own steps
 * and RLS executor without private imports.
 */
export type LifecycleRuntimeAdapters = Readonly<{
	database: LifecycleScopedDatabaseExecutor;
	adapter: UserDataLifecycleAdapter;
}>;

export type PersistentLifecycleRuntimeOptions = Readonly<{
	runtime: LifecycleRuntimeAdapters;
	assertPurgeAllowed: AssertPurgeAllowed;
	hostSteps?: readonly LifecycleHostStep[];
}>;

function immutableContext<
	T extends ExportUserDataContext | PurgeUserDataContext,
>(context: T): T {
	return Object.freeze({ ...context }) as T;
}

/**
 * Creates an immutable, transaction-scoped public lifecycle facade.
 * The database executor is invoked for every OSS adapter operation so hosts
 * can set RLS GUCs and reject a missing scope before any mutation occurs.
 */
export function createPersistentLifecycleRuntime(
	options: PersistentLifecycleRuntimeOptions,
): UserDataLifecycle {
	const hostSteps = orderLifecycleHostSteps(options.hostSteps ?? []);
	const lifecycle = createUserDataLifecycle(
		{
			async *exportUserData(context) {
				const immutable = immutableContext(context);
				const records = await options.runtime.database(immutable, () =>
					composeExport(options.runtime.adapter, hostSteps, immutable),
				);
				for (const record of records) yield record;
			},
			async purgeUserData(context, gate): Promise<PurgeUserDataResult> {
				const immutable = immutableContext(context);
				return options.runtime.database(immutable, async () => {
					const result = await options.runtime.adapter.purgeUserData(immutable, gate);
					if (result.status === "already_completed") return result;

					const deletedByDomain = { ...result.deletedByDomain };
					for (const step of hostSteps) {
						if (!step.purge) continue;
						const outcome = await step.purge(immutable);
						deletedByDomain[`host:${step.id}`] = outcome.deletedCount;
					}
					return { ...result, deletedByDomain };
				});
			},
		},
		async (context) => options.assertPurgeAllowed(immutableContext(context)),
	);

	return lifecycle;
}

async function composeExport(
	adapter: UserDataLifecycleAdapter,
	hostSteps: readonly LifecycleHostStep[],
	context: ExportUserDataContext,
): Promise<UserDataExportRecord[]> {
	const ossRecords: UserDataExportRecord[] = [];
	for await (const record of adapter.exportUserData(context)) ossRecords.push(record);
	const manifest = ossRecords.shift();
	const complete = ossRecords.pop();
	if (manifest?.type !== "manifest" || complete?.type !== "complete") {
		throw new Error("Persistent lifecycle adapter returned an invalid export stream");
	}
	if (ossRecords.some((record) => record.type === "manifest" || record.type === "complete")) {
		throw new Error("Persistent lifecycle adapter returned a reserved record type");
	}

	const hash = new Bun.CryptoHasher("sha256");
	const records: UserDataExportRecord[] = [];
	const append = (record: UserDataExportRecord) => {
		hash.update(`${JSON.stringify(record)}\n`, "utf8");
		records.push(record);
	};
	append(manifest);
	for (const record of ossRecords) append(record);
	for (const step of hostSteps) {
		if (!step.export) continue;
		for await (const record of step.export(context)) {
			if (record.type === "manifest" || record.type === "complete") {
				throw new Error(`Lifecycle host step ${step.id} emitted a reserved record type`);
			}
			append(record);
		}
	}
	records.push({ type: "complete", recordCount: records.length, checksum: hash.digest("hex") });
	return records;
}
