import {
	accounts,
	attachments,
	auditLog,
	categories,
	documentEmbeddings,
	documents,
	folders,
	lifecycleOperations,
	sessions,
	shareLinks,
	tags,
	users,
	versions,
} from "@hiai-docs/db/schema";
import type { TenantTransaction } from "@hiai-docs/db/with-tenant";
import type {
	AssertPurgeAllowed,
	ExportUserDataContext,
	LifecycleHostStep,
	PurgeUserDataContext,
	PurgeUserDataResult,
	UserDataExportRecord,
	UserDataLifecycle,
} from "@hiai-docs/sdk";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";

const LEASE_MS = 60_000;

type PersistentOperation = typeof lifecycleOperations.$inferSelect;

/** A terminal host-fence denial. Never infer this from an Error message. */
export class LifecycleFenceRejectedError extends Error {
	readonly code = "fence_rejected";

	constructor(message = "Purge fence rejected") {
		super(message);
		this.name = "LifecycleFenceRejectedError";
	}
}

/** The durable operation was reclaimed or expired during this worker's run. */
export class LifecycleLeaseLostError extends Error {
	readonly code = "lease_lost";

	constructor() {
		super("Lifecycle operation lease was lost");
		this.name = "LifecycleLeaseLostError";
	}
}

export type LifecycleRuntimeAdapters = Readonly<{
	/** Checks the host-owned fence immediately before the first mutation. */
	verifyPurgeFence: (
		ctx: PurgeUserDataContext,
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
 * The host supplies this executor so every persistent lifecycle query runs in
 * a short transaction with transaction-local `app.current_user_id` GUCs.
 * The lifecycle saga never imports or owns a process-global database client.
 */
export type LifecycleScopedDatabaseExecutor = Readonly<{
	withActorTransaction<T>(
		actorUserId: string,
		operation: (tx: TenantTransaction) => Promise<T>,
	): Promise<T>;
}>;

export type PersistentLifecycleService = Readonly<{
	exportUserData(
		ctx: ExportUserDataContext,
	): AsyncIterable<UserDataExportRecord>;
	purgeUserData(
		ctx: PurgeUserDataContext,
		gate: Readonly<{ fenceToken: string }>,
	): Promise<PurgeUserDataResult>;
}>;

export type PersistentLifecycleRuntimeOptions = Readonly<{
	runtime: LifecycleRuntimeAdapters;
	database: LifecycleScopedDatabaseExecutor;
	assertPurgeAllowed: AssertPurgeAllowed;
	hostSteps?: readonly LifecycleHostStep[];
}>;

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted)
		throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function safeErrorCode(error: unknown): string {
	if (error instanceof DOMException && error.name === "AbortError")
		return "aborted";
	if (error instanceof LifecycleFenceRejectedError) return error.code;
	if (error instanceof LifecycleLeaseLostError) return error.code;
	return "persistence_failed";
}

function tokenHash(token: string): string {
	return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

function subjectHash(actorUserId: string): string {
	return new Bun.CryptoHasher("sha256").update(actorUserId).digest("hex");
}

export function lifecycleTombstoneEmail(actorUserId: string): string {
	const hash = new Bun.CryptoHasher("sha256")
		.update("docsmint:privacy-tombstone:v1\0")
		.update(actorUserId)
		.digest("hex");
	return `deleted-${hash}@invalid.local`;
}

function checksumLine(
	hash: Bun.CryptoHasher,
	record: UserDataExportRecord,
): void {
	hash.update(`${JSON.stringify(record)}\n`, "utf8");
}

function counts(value: unknown): Record<string, number> {
	return typeof value === "object" && value !== null
		? (value as Record<string, number>)
		: {};
}

function operationCounts(
	operation: PersistentOperation,
): Record<string, number> {
	const result = operation.terminalResult as {
		deletedByDomain?: unknown;
	} | null;
	return counts(result?.deletedByDomain);
}

/** Throw on a zero-row lease-fenced write; a stale worker must stop immediately. */
export function requireLeaseWrite<T extends { id: string }>(
	rows: readonly T[],
): void {
	if (rows.length !== 1) throw new LifecycleLeaseLostError();
}

/**
 * Durable OSS-owned lifecycle saga. It knows only OSS-owned data; workspace
 * membership and final-owner policy remain in the injected host fence.
 */
export function createPersistentLifecycleService(
	runtime: LifecycleRuntimeAdapters,
	database: LifecycleScopedDatabaseExecutor,
	hostSteps: readonly LifecycleHostStep[] = [],
): PersistentLifecycleService {
	const orderedSteps = [...hostSteps].sort(
		(a, b) => a.order - b.order || a.id.localeCompare(b.id),
	);
	if (
		new Set(orderedSteps.map((step) => step.id)).size !== orderedSteps.length
	) {
		throw new Error("Lifecycle host step IDs must be globally unique");
	}
	const withActor = <T>(
		actorUserId: string,
		operation: (tx: TenantTransaction) => Promise<T>,
	) => database.withActorTransaction(actorUserId, operation);

	async function getOrCreateOperation(
		ctx: PurgeUserDataContext,
	): Promise<PersistentOperation> {
		return withActor(ctx.actorUserId, async (tx) => {
			await tx
				.insert(lifecycleOperations)
				.values({
					actorUserId: ctx.actorUserId,
					actorSubjectHash: subjectHash(ctx.actorUserId),
					idempotencyKey: ctx.idempotencyKey,
					operationKind: "purge",
					status: "pending",
				})
				.onConflictDoNothing();
			const operation = await tx.query.lifecycleOperations.findFirst({
				where: and(
					eq(lifecycleOperations.actorUserId, ctx.actorUserId),
					eq(lifecycleOperations.idempotencyKey, ctx.idempotencyKey),
				),
			});
			if (operation?.operationKind !== "purge")
				throw new Error("persistence_failed");
			return operation;
		});
	}

	async function acquireLease(
		operation: PersistentOperation,
		actorUserId: string,
		owner: string,
	): Promise<boolean> {
		return withActor(actorUserId, async (tx) => {
			const now = new Date();
			const expiry = new Date(now.getTime() + LEASE_MS);
			const updated = await tx
				.update(lifecycleOperations)
				.set({
					status: "running",
					leaseOwner: owner,
					leaseExpiresAt: expiry,
					attemptCount: sql`${lifecycleOperations.attemptCount} + 1`,
					updatedAt: now,
				})
				.where(
					and(
						eq(lifecycleOperations.id, operation.id),
						or(
							eq(lifecycleOperations.status, "pending"),
							eq(lifecycleOperations.status, "retryable"),
							and(
								eq(lifecycleOperations.status, "running"),
								lt(lifecycleOperations.leaseExpiresAt, now),
							),
						),
					),
				)
				.returning({ id: lifecycleOperations.id });
			return updated.length === 1;
		});
	}

	async function persistStep(
		actorUserId: string,
		operationId: string,
		leaseOwner: string,
		step: string,
		deletedByDomain: Record<string, number>,
	): Promise<void> {
		await withActor(actorUserId, async (tx) => {
			const current = await tx.query.lifecycleOperations.findFirst({
				where: and(
					eq(lifecycleOperations.id, operationId),
					eq(lifecycleOperations.leaseOwner, leaseOwner),
				),
			});
			if (
				current?.status !== "running" ||
				(current.leaseExpiresAt && current.leaseExpiresAt < new Date())
			) {
				throw new LifecycleLeaseLostError();
			}
			const completed = Array.isArray(current.completedSteps)
				? current.completedSteps.filter(
						(value): value is string => typeof value === "string",
					)
				: [];
			if (!completed.includes(step)) completed.push(step);
			const updated = await tx
				.update(lifecycleOperations)
				.set({
					completedSteps: completed,
					terminalResult: { deletedByDomain },
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(lifecycleOperations.id, operationId),
						eq(lifecycleOperations.leaseOwner, leaseOwner),
					),
				)
				.returning({ id: lifecycleOperations.id });
			requireLeaseWrite(updated);
		});
	}

	async function runStep(
		operation: PersistentOperation,
		actorUserId: string,
		leaseOwner: string,
		step: string,
		deletedByDomain: Record<string, number>,
		action: () => Promise<number>,
	): Promise<void> {
		const completed = Array.isArray(operation.completedSteps)
			? operation.completedSteps
			: [];
		if (completed.includes(step)) return;
		const count = await action();
		deletedByDomain[step] = count;
		await persistStep(
			actorUserId,
			operation.id,
			leaseOwner,
			step,
			deletedByDomain,
		);
		operation.completedSteps = [...completed, step];
	}

	return {
		async *exportUserData(ctx) {
			throwIfAborted(ctx.signal);
			const exportId = crypto.randomUUID();
			const hash = new Bun.CryptoHasher("sha256");
			let recordCount = 0;
			const manifest: UserDataExportRecord = {
				type: "manifest",
				schemaVersion: 1,
				exportId,
				actorUserId: ctx.actorUserId,
				generatedAt: new Date().toISOString(),
			};
			checksumLine(hash, manifest);
			recordCount += 1;
			yield manifest;
			const actor = await withActor(ctx.actorUserId, (tx) =>
				tx
					.select({
						id: users.id,
						email: users.email,
						name: users.name,
						emailVerified: users.emailVerified,
						image: users.image,
						createdAt: users.createdAt,
						updatedAt: users.updatedAt,
					})
					.from(users)
					.where(eq(users.id, ctx.actorUserId))
					.limit(1),
			);
			for (const profile of actor) {
				const record: UserDataExportRecord = {
					type: "data",
					domain: "account",
					resourceType: "user",
					resourceId: profile.id,
					workspaceId: null,
					payload: {
						email: profile.email,
						name: profile.name,
						emailVerified: profile.emailVerified,
						image: profile.image,
						createdAt: profile.createdAt,
						updatedAt: profile.updatedAt,
					},
				};
				checksumLine(hash, record);
				recordCount += 1;
				yield record;
			}
			const actorFolders = await withActor(ctx.actorUserId, (tx) =>
				tx.select().from(folders).where(eq(folders.ownerId, ctx.actorUserId)),
			);
			for (const folder of actorFolders) {
				const record: UserDataExportRecord = {
					type: "data",
					domain: "folders",
					resourceType: "folder",
					resourceId: folder.id,
					workspaceId: folder.workspaceId,
					payload: folder,
				};
				checksumLine(hash, record);
				recordCount += 1;
				yield record;
			}
			const actorTags = await withActor(ctx.actorUserId, (tx) =>
				tx.select().from(tags).where(eq(tags.ownerId, ctx.actorUserId)),
			);
			for (const tag of actorTags) {
				const record: UserDataExportRecord = {
					type: "data",
					domain: "tags",
					resourceType: "tag",
					resourceId: tag.id,
					workspaceId: tag.workspaceId,
					payload: tag,
				};
				checksumLine(hash, record);
				recordCount += 1;
				yield record;
			}
			const actorCategories = await withActor(ctx.actorUserId, (tx) =>
				tx
					.select()
					.from(categories)
					.where(eq(categories.ownerId, ctx.actorUserId)),
			);
			for (const category of actorCategories) {
				const record: UserDataExportRecord = {
					type: "data",
					domain: "categories",
					resourceType: "category",
					resourceId: category.id,
					workspaceId: category.workspaceId,
					payload: category,
				};
				checksumLine(hash, record);
				recordCount += 1;
				yield record;
			}
			const ownedDocuments = await withActor(ctx.actorUserId, (tx) =>
				tx
					.select()
					.from(documents)
					.where(eq(documents.ownerId, ctx.actorUserId)),
			);
			for (const document of ownedDocuments) {
				throwIfAborted(ctx.signal);
				const record: UserDataExportRecord = {
					type: "data",
					domain: "documents",
					resourceType: "document",
					resourceId: document.id,
					workspaceId: document.workspaceId,
					payload: {
						title: document.title,
						content: document.content,
						contentJson: document.contentJson,
						metadata: document.metadata,
						visibility: document.visibility,
						createdAt: document.createdAt,
						updatedAt: document.updatedAt,
					},
				};
				checksumLine(hash, record);
				recordCount += 1;
				yield record;
			}
			const ownedAttachments = await withActor(ctx.actorUserId, (tx) =>
				tx
					.select({
						id: attachments.id,
						workspaceId: attachments.workspaceId,
						filename: attachments.filename,
						mimeType: attachments.mimeType,
						size: attachments.size,
					})
					.from(attachments)
					.innerJoin(documents, eq(attachments.documentId, documents.id))
					.where(eq(documents.ownerId, ctx.actorUserId)),
			);
			for (const attachment of ownedAttachments) {
				throwIfAborted(ctx.signal);
				const record: UserDataExportRecord = {
					type: "attachment",
					attachmentId: attachment.id,
					workspaceId: attachment.workspaceId,
					filename: attachment.filename,
					contentType: attachment.mimeType,
					size: attachment.size,
					sha256: null,
				};
				checksumLine(hash, record);
				recordCount += 1;
				yield record;
			}
			for (const step of orderedSteps) {
				if (!step.export) continue;
				for await (const record of step.export(ctx)) {
					throwIfAborted(ctx.signal);
					if (record.type === "manifest" || record.type === "complete")
						throw new Error("Host export step emitted a reserved record type");
					checksumLine(hash, record);
					recordCount += 1;
					yield record;
				}
			}
			yield { type: "complete", recordCount, checksum: hash.digest("hex") };
		},

		async purgeUserData(ctx, gate) {
			throwIfAborted(ctx.signal);
			let operation = await getOrCreateOperation(ctx);
			if (operation.status === "completed")
				return {
					status: "already_completed",
					operationId: operation.id,
					deletedByDomain: operationCounts(operation),
				};
			const leaseOwner = crypto.randomUUID();
			if (!(await acquireLease(operation, ctx.actorUserId, leaseOwner)))
				throw new LifecycleLeaseLostError();
			operation = await withActor(
				ctx.actorUserId,
				async (tx) =>
					(await tx.query.lifecycleOperations.findFirst({
						where: eq(lifecycleOperations.id, operation.id),
					})) ?? operation,
			);
			const deletedByDomain = operationCounts(operation);
			try {
				throwIfAborted(ctx.signal);
				await withActor(ctx.actorUserId, async (tx) => {
					const updated = await tx
						.update(lifecycleOperations)
						.set({
							fenceTokenHash: tokenHash(gate.fenceToken),
							updatedAt: new Date(),
						})
						.where(
							and(
								eq(lifecycleOperations.id, operation.id),
								eq(lifecycleOperations.leaseOwner, leaseOwner),
							),
						)
						.returning({ id: lifecycleOperations.id });
					requireLeaseWrite(updated);
				});
				await runtime.verifyPurgeFence(ctx, gate.fenceToken);
				const dbDelete = <T extends { id: string }>(
					action: (tx: TenantTransaction) => Promise<T[]>,
				) => withActor(ctx.actorUserId, action).then((rows) => rows.length);
				await runStep(
					operation,
					ctx.actorUserId,
					leaseOwner,
					"cancel_account_jobs",
					deletedByDomain,
					() => runtime.cancelAccountJobs(ctx.actorUserId, ctx.signal),
				);
				await runStep(
					operation,
					ctx.actorUserId,
					leaseOwner,
					"remove_collaboration_state",
					deletedByDomain,
					() => runtime.removeCollaborationState(ctx.actorUserId, ctx.signal),
				);
				await runStep(
					operation,
					ctx.actorUserId,
					leaseOwner,
					"remove_subject_created_shares",
					deletedByDomain,
					() =>
						dbDelete((tx) =>
							tx
								.delete(shareLinks)
								.where(eq(shareLinks.createdBy, ctx.actorUserId))
								.returning({ id: shareLinks.id }),
						),
				);
				const owned = await withActor(ctx.actorUserId, (tx) =>
					tx
						.select({ id: documents.id })
						.from(documents)
						.where(eq(documents.ownerId, ctx.actorUserId)),
				);
				const documentIds = owned.map((row) => row.id);
				await runStep(
					operation,
					ctx.actorUserId,
					leaseOwner,
					"remove_document_versions",
					deletedByDomain,
					() =>
						documentIds.length
							? dbDelete((tx) =>
									tx
										.delete(versions)
										.where(inArray(versions.documentId, documentIds))
										.returning({ id: versions.id }),
								)
							: Promise.resolve(0),
				);
				await runStep(
					operation,
					ctx.actorUserId,
					leaseOwner,
					"remove_chunks_and_embeddings",
					deletedByDomain,
					() =>
						documentIds.length
							? dbDelete((tx) =>
									tx
										.delete(documentEmbeddings)
										.where(inArray(documentEmbeddings.documentId, documentIds))
										.returning({ id: documentEmbeddings.id }),
								)
							: Promise.resolve(0),
				);
				await runStep(
					operation,
					ctx.actorUserId,
					leaseOwner,
					"remove_graph_state",
					deletedByDomain,
					() => runtime.removeGraphState(documentIds, ctx.signal),
				);
				const objectRows = documentIds.length
					? await withActor(ctx.actorUserId, (tx) =>
							tx
								.select({
									id: attachments.id,
									storageKey: attachments.storageKey,
								})
								.from(attachments)
								.where(inArray(attachments.documentId, documentIds)),
						)
					: [];
				await runStep(
					operation,
					ctx.actorUserId,
					leaseOwner,
					"delete_attachment_objects",
					deletedByDomain,
					() =>
						runtime.deleteObjects(
							objectRows.map((row) => row.storageKey),
							ctx.signal,
						),
				);
				await runStep(
					operation,
					ctx.actorUserId,
					leaseOwner,
					"remove_subject_folders",
					deletedByDomain,
					() =>
						dbDelete((tx) =>
							tx
								.delete(folders)
								.where(eq(folders.ownerId, ctx.actorUserId))
								.returning({ id: folders.id }),
						),
				);
				await runStep(
					operation,
					ctx.actorUserId,
					leaseOwner,
					"remove_subject_tags",
					deletedByDomain,
					() =>
						dbDelete((tx) =>
							tx
								.delete(tags)
								.where(eq(tags.ownerId, ctx.actorUserId))
								.returning({ id: tags.id }),
						),
				);
				await runStep(
					operation,
					ctx.actorUserId,
					leaseOwner,
					"remove_subject_categories",
					deletedByDomain,
					() =>
						dbDelete((tx) =>
							tx
								.delete(categories)
								.where(eq(categories.ownerId, ctx.actorUserId))
								.returning({ id: categories.id }),
						),
				);
				await runStep(
					operation,
					ctx.actorUserId,
					leaseOwner,
					"remove_attachment_rows",
					deletedByDomain,
					() =>
						objectRows.length
							? dbDelete((tx) =>
									tx
										.delete(attachments)
										.where(
											inArray(
												attachments.id,
												objectRows.map((row) => row.id),
											),
										)
										.returning({ id: attachments.id }),
								)
							: Promise.resolve(0),
				);
				await runStep(
					operation,
					ctx.actorUserId,
					leaseOwner,
					"remove_subject_documents",
					deletedByDomain,
					() =>
						dbDelete((tx) =>
							tx
								.delete(documents)
								.where(eq(documents.ownerId, ctx.actorUserId))
								.returning({ id: documents.id }),
						),
				);
				await runStep(
					operation,
					ctx.actorUserId,
					leaseOwner,
					"clear_redis_state",
					deletedByDomain,
					() => runtime.clearAccountRedisState(ctx.actorUserId, ctx.signal),
				);
				for (const step of orderedSteps)
					if (step.purge)
						await runStep(
							operation,
							ctx.actorUserId,
							leaseOwner,
							`host:${step.id}`,
							deletedByDomain,
							async () => (await step.purge?.(ctx))?.deletedCount ?? 0,
						);
				await runStep(
					operation,
					ctx.actorUserId,
					leaseOwner,
					"remove_auth_sessions",
					deletedByDomain,
					() =>
						dbDelete((tx) =>
							tx
								.delete(sessions)
								.where(eq(sessions.userId, ctx.actorUserId))
								.returning({ id: sessions.id }),
						),
				);
				await runStep(
					operation,
					ctx.actorUserId,
					leaseOwner,
					"remove_auth_accounts",
					deletedByDomain,
					() =>
						dbDelete((tx) =>
							tx
								.delete(accounts)
								.where(eq(accounts.userId, ctx.actorUserId))
								.returning({ id: accounts.id }),
						),
				);
				await runStep(
					operation,
					ctx.actorUserId,
					leaseOwner,
					"tombstone_subject_user",
					deletedByDomain,
					() =>
						dbDelete((tx) =>
							tx
								.update(users)
								.set({
									email: lifecycleTombstoneEmail(ctx.actorUserId),
									name: null,
									image: null,
									emailVerified: false,
									updatedAt: new Date(),
								})
								.where(eq(users.id, ctx.actorUserId))
								.returning({ id: users.id }),
						),
				);
				await runStep(
					operation,
					ctx.actorUserId,
					leaseOwner,
					"write_deletion_audit",
					deletedByDomain,
					async () => {
						await withActor(ctx.actorUserId, (tx) =>
							tx.insert(auditLog).values({
								actorId: ctx.actorUserId,
								action: "account_data_purged",
								resourceType: "lifecycle_operation",
								details: {
									operationId: operation.id,
									outcome: "completed",
									deletedByDomain,
								},
							}),
						);
						return 1;
					},
				);
				await withActor(ctx.actorUserId, async (tx) => {
					const updated = await tx
						.update(lifecycleOperations)
						.set({
							status: "completed",
							terminalResult: { deletedByDomain },
							completedAt: new Date(),
							leaseOwner: null,
							leaseExpiresAt: null,
							updatedAt: new Date(),
						})
						.where(
							and(
								eq(lifecycleOperations.id, operation.id),
								eq(lifecycleOperations.leaseOwner, leaseOwner),
							),
						)
						.returning({ id: lifecycleOperations.id });
					requireLeaseWrite(updated);
				});
				return {
					status: "completed",
					operationId: operation.id,
					deletedByDomain,
				};
			} catch (error) {
				if (error instanceof LifecycleLeaseLostError) throw error;
				const code = safeErrorCode(error);
				await withActor(ctx.actorUserId, async (tx) => {
					const updated = await tx
						.update(lifecycleOperations)
						.set({
							status:
								error instanceof LifecycleFenceRejectedError
									? "rejected"
									: "retryable",
							safeErrorCode: code,
							leaseOwner: null,
							leaseExpiresAt: null,
							completedAt:
								error instanceof LifecycleFenceRejectedError
									? new Date()
									: null,
							updatedAt: new Date(),
						})
						.where(
							and(
								eq(lifecycleOperations.id, operation.id),
								eq(lifecycleOperations.leaseOwner, leaseOwner),
							),
						)
						.returning({ id: lifecycleOperations.id });
					requireLeaseWrite(updated);
				});
				throw error;
			}
		},
	};
}

export function bindPersistentLifecycle(
	service: PersistentLifecycleService,
	assertPurgeAllowed: AssertPurgeAllowed,
): UserDataLifecycle {
	return {
		exportUserData: service.exportUserData,
		async purgeUserData(ctx) {
			const gate = await assertPurgeAllowed(ctx);
			return service.purgeUserData(ctx, gate);
		},
	};
}

export function createPersistentLifecycleRuntime(
	options: PersistentLifecycleRuntimeOptions,
): UserDataLifecycle {
	const service = createPersistentLifecycleService(
		options.runtime,
		options.database,
		options.hostSteps ?? [],
	);
	return bindPersistentLifecycle(service, options.assertPurgeAllowed);
}
