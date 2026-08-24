/**
 * @internal
 *
 * Re-embed helpers used by tag / folder / category mutation routes.
 *
 * Before this module existed, every metadata-triggered re-embed (rename a
 * tag, rename a folder, delete a category, ...) lived as inline logic in
 * its own route handler with subtly different dedup strategies and batch
 * limits. That made it easy to:
 *   - forget a trigger (e.g. category rename never re-embedded anything
 *     before this refactor, leaving stale vectors that still referenced
 *     the old category name in the preamble).
 *   - ship inconsistent dedup, so rapid PATCH storms could enqueue the
 *     same document id several times.
 *
 * This module is the single entry point for metadata-driven re-embed.
 * Route handlers should call one of `reembedDocsInFolder`,
 * `reembedDocsInCategory`, or `reembedDocsByTag` instead of
 * `enqueueEmbedding` directly. Direct calls remain valid for content
 * edits, document creates, and admin reindex - paths where dedup-by-id
 * is not desirable.
 *
 * Snapshot functions are deliberately transactional and may throw so the
 * metadata mutation rolls back rather than committing without durable work.
 * Dispatch happens after commit: failed rows remain in the durable outbox for
 * immediate or startup recovery instead of failing the metadata mutation.
 *   - A per-document Redis SET-NX slot (5s TTL) prevents rapid PATCH /
 *     toggle storms from queueing the same doc more than once in that
 *     window. The worker itself dedupes via `contentHash`, but the slot
 *     here saves the worker from processing redundant no-op updates.
 *
 * Exported surface is intentionally narrow - everything that is not part
 * of the public route-integration contract is kept module-private.
 */

import {
	documents,
	documentTags,
	folders,
	metadataReembedOutbox,
	tags,
} from "@hiai-docs/db/schema";
import {
	adminTenantContext,
	type TenantContext,
	type TenantTransaction,
	withTenant,
	ZERO_UUID,
} from "@hiai-docs/db/with-tenant";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
	enqueueMetadataReembedPrepareJobsBulk,
	type MetadataReembedPrepareJob,
} from "../queue/enqueue";
import { config } from "./config";
import { tenantOwnerCondition, tenantOwnerSql } from "./content-access";
import { contentHash } from "./content-hash";
import { enqueueEmbedding } from "./embedding-queue";
import { logger } from "./logger";
import { redis } from "./redis";
import { acquireTenantTopologyLock } from "./topology-serialization";

/**
 * Per-doc dedup slot prefix. Combined with a 5-second TTL this absorbs
 * rapid PATCH / toggle storms on the same doc - long enough to coalesce
 * auto-save keystrokes and rapid tag toggles, short enough that a real
 * follow-up edit (after a human-readable pause) still goes through.
 */
const DEDUP_KEY_PREFIX = "hiai-docs:reembed:dedup:";
const DEDUP_TTL_SECONDS = 5;
const REEMBED_ADMIN_TENANT = adminTenantContext(ZERO_UUID);

export type ReembedRefreshReason = "content" | "metadata" | "reindex";
export type ReembedRefreshMode = "incremental" | "full";

export type ReembedTarget = Readonly<{
	id: string;
	revision: string;
	generationId?: string;
}>;

type ReembedTargetInput = string | ReembedTarget | null | undefined;

type ReembedDocumentRow = Readonly<{
	id: string;
	title: string;
	content: string | null;
}>;

export type MetadataImpactTarget =
	| Readonly<{ kind: "folder"; id: string }>
	| Readonly<{ kind: "category"; id: string }>;

export type MetadataImpactSnapshot = Readonly<{
	folderIds: readonly string[];
	operationId: string;
	targetCount: number;
}>;

export type DocumentMetadataImpactSnapshot = Readonly<{
	operationId: string;
	targetCount: number;
}>;

export type MetadataReembedOutboxTarget = Readonly<{
	id: string;
	documentId: string;
	ownerId: string;
	workspaceId?: string;
	revision: string;
	createdAt: string;
}>;

async function loadMetadataImpactFolderIds(
	tx: TenantTransaction,
	ctx: TenantContext,
	target: MetadataImpactTarget,
): Promise<string[]> {
	const rows =
		target.kind === "folder"
			? ((await tx.execute(sql`
				/* docsmint:metadata-impact:folder */
				WITH RECURSIVE affected_folders AS (
					SELECT f.id
					FROM folders f
					WHERE f.id = ${target.id}
						AND ${tenantOwnerSql("f", ctx)}
					UNION ALL
					SELECT child.id
					FROM folders child
					JOIN affected_folders parent ON child.parent_id = parent.id
					WHERE ${tenantOwnerSql("child", ctx)}
				)
				SELECT id FROM affected_folders ORDER BY id
			`)) as unknown as Array<{ id: string }>)
			: ((await tx.execute(sql`
				/* docsmint:metadata-impact:category */
				WITH RECURSIVE resolved_folders AS (
					SELECT f.id, f.parent_id, f.category_id,
						f.category_id AS effective_category_id
					FROM folders f
					WHERE f.parent_id IS NULL
						AND ${tenantOwnerSql("f", ctx)}
					UNION ALL
					SELECT child.id, child.parent_id, child.category_id,
						coalesce(child.category_id, parent.effective_category_id)
					FROM folders child
					JOIN resolved_folders parent ON child.parent_id = parent.id
					WHERE ${tenantOwnerSql("child", ctx)}
				)
				SELECT id
				FROM resolved_folders
				WHERE effective_category_id = ${target.id}
				ORDER BY id
			`)) as unknown as Array<{ id: string }>);
	return rows.map((row) => row.id);
}

function metadataImpactDocumentCondition(
	target: MetadataImpactTarget,
	folderIds: readonly string[],
) {
	if (target.kind === "folder") {
		return folderIds.length > 0
			? inArray(documents.folderId, [...folderIds])
			: sql`false`;
	}
	return folderIds.length > 0
		? or(
				eq(documents.categoryId, target.id),
				and(
					isNull(documents.categoryId),
					inArray(documents.folderId, [...folderIds]),
				),
			)
		: eq(documents.categoryId, target.id);
}

async function insertMetadataImpactOutbox(
	tx: TenantTransaction,
	ctx: TenantContext,
	target: MetadataImpactTarget,
	folderIds: readonly string[],
	operationId: string,
): Promise<number> {
	if (target.kind === "folder" && folderIds.length === 0) return 0;
	await tx.execute(sql`
		INSERT INTO public.metadata_reembed_outbox
			(id, operation_id, document_id, owner_id, workspace_id, revision, created_at)
		SELECT
			gen_random_uuid(),
			${operationId}::uuid,
			${documents.id},
			${documents.ownerId},
			${documents.workspaceId},
			encode(
				digest(${documents.title} || E'\n' || coalesce(${documents.content}, ''), 'sha256'),
				'hex'
			),
			statement_timestamp()
		FROM ${documents}
		WHERE ${and(
			metadataImpactDocumentCondition(target, folderIds),
			tenantOwnerCondition(documents.ownerId, documents.workspaceId, ctx),
		)}
		ON CONFLICT (operation_id, document_id) DO NOTHING
	`);
	const [countRow] = await tx
		.select({ count: sql<number>`count(*)::int` })
		.from(metadataReembedOutbox)
		.where(eq(metadataReembedOutbox.operationId, operationId));
	return countRow?.count ?? 0;
}

/** Resolve, optionally lock, and durably snapshot one metadata-impact domain. */
export async function snapshotMetadataImpact(
	tx: TenantTransaction,
	ctx: TenantContext,
	target: MetadataImpactTarget,
	options: Readonly<{ lockFolders?: boolean }> = {},
): Promise<MetadataImpactSnapshot> {
	await acquireTenantTopologyLock(tx, ctx);
	const folderIds = await loadMetadataImpactFolderIds(tx, ctx, target);
	if (options.lockFolders && folderIds.length > 0) {
		await tx
			.select({ id: folders.id })
			.from(folders)
			.where(
				and(
					inArray(folders.id, folderIds),
					tenantOwnerCondition(folders.ownerId, folders.workspaceId, ctx),
				),
			)
			.orderBy(asc(folders.id))
			.for("update");
	}
	const operationId = crypto.randomUUID();
	const targetCount = await insertMetadataImpactOutbox(
		tx,
		ctx,
		target,
		folderIds,
		operationId,
	);
	return { folderIds, operationId, targetCount };
}

/** Durably snapshot one metadata-bearing document mutation in its caller's transaction. */
export async function snapshotDocumentMetadataImpact(
	tx: TenantTransaction,
	ctx: TenantContext,
	documentId: string,
): Promise<DocumentMetadataImpactSnapshot> {
	await acquireTenantTopologyLock(tx, ctx);
	const operationId = crypto.randomUUID();
	await tx.execute(sql`
		INSERT INTO public.metadata_reembed_outbox
			(id, operation_id, document_id, owner_id, workspace_id, revision, created_at)
		SELECT
			gen_random_uuid(),
			${operationId}::uuid,
			${documents.id},
			${documents.ownerId},
			${documents.workspaceId},
			encode(
				digest(${documents.title} || E'\n' || coalesce(${documents.content}, ''), 'sha256'),
				'hex'
			),
			statement_timestamp()
		FROM ${documents}
		WHERE ${and(
			eq(documents.id, documentId),
			tenantOwnerCondition(documents.ownerId, documents.workspaceId, ctx),
		)}
		ON CONFLICT (operation_id, document_id) DO NOTHING
	`);
	const [countRow] = await tx
		.select({ count: sql<number>`count(*)::int` })
		.from(metadataReembedOutbox)
		.where(eq(metadataReembedOutbox.operationId, operationId));
	return { operationId, targetCount: countRow?.count ?? 0 };
}

type ReembedPageLoader = (
	cursor: string | undefined,
	limit: number,
) => Promise<readonly ReembedDocumentRow[]>;

function toReembedTarget(row: ReembedDocumentRow): ReembedTarget {
	return {
		id: row.id,
		revision: contentHash(row.title, row.content ?? ""),
	};
}

async function enqueueReembedPages(
	loadPage: ReembedPageLoader,
	limit: number,
	workspaceId?: string,
	options: {
		refreshMode: ReembedRefreshMode;
		reason: ReembedRefreshReason;
		source?: "interactive" | "reindex";
		bypassDedup?: boolean;
		forceNewGeneration?: boolean;
	} = { refreshMode: "full", reason: "metadata" },
): Promise<number> {
	let cursor: string | undefined;
	let enqueued = 0;
	let hasNextPage = true;
	while (hasNextPage) {
		const rows = await loadPage(cursor, limit);
		if (rows.length === 0) return enqueued;
		enqueued += await enqueueReembed(
			rows.map(toReembedTarget),
			workspaceId,
			options,
		);
		const nextCursor = rows.at(-1)?.id;
		hasNextPage =
			limit > 0 &&
			rows.length >= limit &&
			typeof nextCursor === "string" &&
			nextCursor !== cursor;
		cursor = nextCursor;
	}
	return enqueued;
}

/**
 * Try to claim a one-shot enqueue slot for `docId`. Returns `true` if the
 * caller should proceed with the enqueue, `false` if a recent enqueue is
 * already in flight for this document id (within the TTL window).
 *
 * Uses Redis `SET key 1 NX EX 5`, which is atomic - exactly one caller
 * wins the slot per TTL window even under heavy concurrency. If Redis
 * is unreachable, we err on the side of "go ahead and enqueue" so a
 * Redis outage does not silently drop re-embed work.
 *
 * @internal
 */
async function claimEnqueueSlot(
	docId: string,
	workspaceId?: string,
	identity?: Readonly<{
		revision: string;
		refreshMode: ReembedRefreshMode;
		reason: ReembedRefreshReason;
	}>,
): Promise<boolean> {
	const scope = workspaceId ? `${encodeURIComponent(workspaceId)}:` : "";
	const suffix = identity
		? `:${encodeURIComponent(identity.revision)}:${identity.refreshMode}:${identity.reason}`
		: "";
	const key = `${DEDUP_KEY_PREFIX}${scope}${encodeURIComponent(docId)}${suffix}`;
	try {
		const result = await redis.set(key, "1", "EX", DEDUP_TTL_SECONDS, "NX");
		return result === "OK";
	} catch (err) {
		logger.warn(
			{ err, docId },
			"Redis dedup check failed - proceeding with enqueue",
		);
		return true;
	}
}

/**
 * Enqueue a unique set of document ids for re-embedding. Per-id Redis
 * SET-NX dedup (5s TTL) prevents storms. Returns the number of ids that
 * were actually pushed to the worker queue (i.e. dedup-skipped ids are
 * NOT counted).
 *
 * This is the lowest-level helper exported from this module. The
 * domain-specific helpers below (`reembedDocsInFolder`,
 * `reembedDocsInCategory`, `reembedDocsByTag`) are thin wrappers that
 * resolve ids from the database and then call this function.
 *
 * @internal
 */
export async function enqueueReembed(
	docIds: Iterable<ReembedTargetInput>,
	workspaceId?: string,
	options: {
		bypassDedup?: boolean;
		forceNewGeneration?: boolean;
		source?: "interactive" | "reindex";
		refreshMode?: ReembedRefreshMode;
		reason?: ReembedRefreshReason;
	} = {},
): Promise<number> {
	const refreshMode = options.refreshMode ?? "incremental";
	const reason = options.reason ?? "content";
	const unique = new Map<
		string,
		{ id: string; revision?: string; generationId?: string }
	>();
	for (const target of docIds) {
		const id = typeof target === "string" ? target : target?.id;
		if (typeof id !== "string" || id.trim().length === 0) continue;
		const revision = typeof target === "string" ? undefined : target?.revision;
		const generationId =
			typeof target === "string" ? undefined : target?.generationId;
		if (revision !== undefined && revision.trim().length === 0) continue;
		const identity = revision
			? `${id}\u0000${revision}\u0000${refreshMode}\u0000${reason}`
			: id;
		unique.set(identity, { id, revision, generationId });
	}

	let pushed = 0;
	for (const { id, revision, generationId } of unique.values()) {
		if (
			options.bypassDedup ||
			(await claimEnqueueSlot(
				id,
				workspaceId,
				revision ? { revision, refreshMode, reason } : undefined,
			))
		) {
			// Keep the legacy list bridge for metadata-triggered re-embeds until
			// the reconciliation worker owns this path. The bridge accepts the
			// document id and preserves existing dedup/retry behavior.
			const queued = await enqueueEmbedding(
				id,
				options.source ?? "interactive",
				workspaceId,
				{
					forceNewGeneration:
						options.forceNewGeneration ?? refreshMode === "full",
					refreshMode,
					...(revision ? { revision } : {}),
					...(generationId ? { generationId } : {}),
				},
			);
			if (queued) pushed += 1;
		}
	}
	return pushed;
}

type MetadataOutboxCursor = Readonly<{ createdAt: string; id: string }>;

type MetadataOutboxStageResult = Readonly<{
	jobs: readonly MetadataReembedPrepareJob[];
	completedIds: readonly string[];
}>;

type MetadataOutboxDrainDependencies = Readonly<{
	loadPage: (
		operationId: string | undefined,
		cursor: MetadataOutboxCursor | undefined,
		limit: number,
	) => Promise<readonly MetadataReembedOutboxTarget[]>;
	stagePage: (
		targets: readonly MetadataReembedOutboxTarget[],
	) => Promise<MetadataOutboxStageResult>;
	enqueueBulk: (
		jobs: readonly MetadataReembedPrepareJob[],
	) => Promise<Readonly<{ acceptedIds: string[]; deduplicatedIds: string[] }>>;
	acknowledge: (ids: readonly string[]) => Promise<void>;
}>;

/** @internal Deterministic bounded-memory seam for outbox dispatch tests. */
export async function drainMetadataReembedOutboxPagesWith(
	operationId: string | undefined,
	pageSize: number,
	dependencies: MetadataOutboxDrainDependencies,
): Promise<{ enqueued: number; completed: number; failed: number }> {
	const boundedPageSize = Math.max(1, pageSize);
	let cursor: MetadataOutboxCursor | undefined;
	let enqueued = 0;
	let completed = 0;
	let failed = 0;
	while (true) {
		const rows = await dependencies.loadPage(
			operationId,
			cursor,
			boundedPageSize,
		);
		if (rows.length === 0) break;
		let staged: MetadataOutboxStageResult;
		try {
			staged = await dependencies.stagePage(rows);
		} catch (err) {
			logger.warn({ err }, "Metadata re-embed outbox page staging failed");
			staged = { jobs: [], completedIds: [] };
		}
		let acceptedIds: readonly string[] = [];
		let deduplicatedIds: readonly string[] = [];
		if (staged.jobs.length > 0) {
			try {
				const result = await dependencies.enqueueBulk(staged.jobs);
				acceptedIds = result.acceptedIds;
				deduplicatedIds = result.deduplicatedIds;
			} catch (err) {
				logger.warn({ err }, "Metadata re-embed outbox bulk dispatch failed");
			}
		}
		const acknowledged = [
			...new Set([...staged.completedIds, ...acceptedIds, ...deduplicatedIds]),
		];
		const acknowledgedSet = new Set(acknowledged);
		enqueued += acceptedIds.length;
		completed += acknowledged.length;
		failed += rows.filter(({ id }) => !acknowledgedSet.has(id)).length;
		if (acknowledged.length > 0) {
			await dependencies.acknowledge(acknowledged);
		}
		const lastRow = rows.at(-1);
		const nextCursor = lastRow
			? { createdAt: lastRow.createdAt, id: lastRow.id }
			: undefined;
		if (
			rows.length < boundedPageSize ||
			!nextCursor ||
			(nextCursor.id === cursor?.id &&
				nextCursor.createdAt === cursor.createdAt)
		) {
			break;
		}
		cursor = nextCursor;
	}
	return { enqueued, completed, failed };
}

async function loadMetadataOutboxPage(
	operationId: string | undefined,
	cursor: MetadataOutboxCursor | undefined,
	limit: number,
): Promise<readonly MetadataReembedOutboxTarget[]> {
	const rows = await withTenant(REEMBED_ADMIN_TENANT, (tx) => {
		const baseQuery = tx
			.select({
				id: metadataReembedOutbox.id,
				documentId: metadataReembedOutbox.documentId,
				ownerId: metadataReembedOutbox.ownerId,
				workspaceId: metadataReembedOutbox.workspaceId,
				revision: metadataReembedOutbox.revision,
				createdAt: sql<string>`${metadataReembedOutbox.createdAt}::text`,
			})
			.from(metadataReembedOutbox);
		if (operationId) {
			return baseQuery
				.where(
					and(
						eq(metadataReembedOutbox.operationId, operationId),
						...(cursor ? [gt(metadataReembedOutbox.id, cursor.id)] : []),
					),
				)
				.orderBy(asc(metadataReembedOutbox.id))
				.limit(limit);
		}
		return baseQuery
			.where(
				cursor
					? sql`(${metadataReembedOutbox.createdAt}, ${metadataReembedOutbox.id}) > (${cursor.createdAt}::timestamp, ${cursor.id}::uuid)`
					: undefined,
			)
			.orderBy(
				asc(metadataReembedOutbox.createdAt),
				asc(metadataReembedOutbox.id),
			)
			.limit(limit);
	});
	return rows.map((row) => ({
		...row,
		workspaceId: row.workspaceId ?? undefined,
	}));
}

type MetadataStagingRow = Readonly<{
	outbox_id: string;
	document_id: string;
	owner_id: string;
	workspace_id: string | null;
	revision: string;
	created_at: string;
	status: string | null;
	prepare_status: string | null;
	ordinal: number;
}>;

/** Stage one bounded outbox page in a fixed number of set-based DB statements. */
async function stageMetadataOutboxPage(
	targets: readonly MetadataReembedOutboxTarget[],
): Promise<MetadataOutboxStageResult> {
	if (targets.length === 0) return { jobs: [], completedIds: [] };
	const payload = JSON.stringify(
		targets.map((target, ordinal) => ({
			outbox_id: target.id,
			document_id: target.documentId,
			owner_id: target.ownerId,
			workspace_id: target.workspaceId ?? null,
			revision: target.revision,
			created_at: target.createdAt,
			ordinal,
		})),
	);
	const staged = await withTenant(REEMBED_ADMIN_TENANT, async (tx) => {
		await tx.execute(sql`
			WITH input AS (
				SELECT * FROM jsonb_to_recordset(${payload}::jsonb) AS row(
					outbox_id uuid,
					document_id uuid,
					owner_id uuid,
					workspace_id text,
					revision text,
					created_at timestamp,
					ordinal integer
				)
			), locked_documents AS MATERIALIZED (
				SELECT document.id, input.revision
				FROM input
				JOIN public.documents AS document
					ON document.id = input.document_id
					AND document.owner_id = input.owner_id
					AND document.workspace_id IS NOT DISTINCT FROM input.workspace_id
					AND encode(
						digest(document.title || E'\n' || coalesce(document.content, ''), 'sha256'),
						'hex'
					) = input.revision
				ORDER BY document.id
				FOR UPDATE OF document
			)
			UPDATE public.documents AS document
			SET embedding_status = 'stale',
				embedding_error_code = NULL,
				content_hash = locked_documents.revision,
				updated_at = now()
			FROM locked_documents
			WHERE document.id = locked_documents.id
		`);
		await tx.execute(sql`
			WITH input AS (
				SELECT * FROM jsonb_to_recordset(${payload}::jsonb) AS row(
					outbox_id uuid,
					document_id uuid,
					owner_id uuid,
					workspace_id text,
					revision text,
					created_at timestamp,
					ordinal integer
				)
			)
			INSERT INTO public.document_pipeline_runs (
				document_id,
				owner_id,
				workspace_id,
				generation_id,
				revision,
				source,
				refresh_mode,
				requested_at
			)
			SELECT
				input.document_id,
				input.owner_id,
				input.workspace_id,
				input.outbox_id,
				input.revision,
				'interactive',
				'full',
				input.created_at
			FROM input
			JOIN public.documents AS document
				ON document.id = input.document_id
				AND document.owner_id = input.owner_id
				AND document.workspace_id IS NOT DISTINCT FROM input.workspace_id
				AND encode(
					digest(document.title || E'\n' || coalesce(document.content, ''), 'sha256'),
					'hex'
				) = input.revision
			ON CONFLICT (document_id, generation_id) DO NOTHING
		`);
		await tx.execute(sql`
			WITH input AS (
				SELECT * FROM jsonb_to_recordset(${payload}::jsonb) AS row(
					outbox_id uuid,
					document_id uuid,
					owner_id uuid,
					workspace_id text,
					revision text,
					created_at timestamp,
					ordinal integer
				)
			), input_documents AS (
				SELECT DISTINCT run.document_id
				FROM public.document_pipeline_runs AS run
				JOIN input
					ON input.document_id = run.document_id
					AND input.outbox_id = run.generation_id
			), latest AS (
				SELECT DISTINCT ON (run.document_id)
					run.document_id, run.generation_id, run.requested_at
				FROM public.document_pipeline_runs AS run
				JOIN input_documents ON input_documents.document_id = run.document_id
				WHERE run.status IN ('pending', 'processing', 'retrying')
				ORDER BY run.document_id, run.requested_at DESC, run.generation_id DESC
			)
			UPDATE public.document_pipeline_runs AS run
			SET status = 'cancelled',
				error_code = 'superseded_by_reindex',
				updated_at = now()
			FROM latest
			WHERE run.document_id = latest.document_id
				AND run.status IN ('pending', 'processing', 'retrying')
				AND (run.requested_at, run.generation_id)
					< (latest.requested_at, latest.generation_id)
		`);
		return (await tx.execute(sql`
			WITH input AS (
				SELECT * FROM jsonb_to_recordset(${payload}::jsonb) AS row(
					outbox_id uuid,
					document_id uuid,
					owner_id uuid,
					workspace_id text,
					revision text,
					created_at timestamp,
					ordinal integer
				)
			)
			SELECT
				input.outbox_id::text,
				input.document_id::text,
				input.owner_id::text,
				input.workspace_id,
				input.revision,
				to_char(input.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
				run.status,
				run.prepare_status,
				input.ordinal
			FROM input
			LEFT JOIN public.document_pipeline_runs AS run
				ON run.document_id = input.document_id
				AND run.generation_id = input.outbox_id
			ORDER BY input.ordinal
		`)) as unknown as MetadataStagingRow[];
	});
	const jobs: MetadataReembedPrepareJob[] = [];
	const completedIds: string[] = [];
	for (const row of staged) {
		if (row.status === "pending" && row.prepare_status === "pending") {
			jobs.push({
				outboxId: row.outbox_id,
				documentId: row.document_id,
				ownerId: row.owner_id,
				workspaceId: row.workspace_id ?? undefined,
				generationId: row.outbox_id,
				revision: row.revision,
				requestedAt: row.created_at,
			});
		} else {
			completedIds.push(row.outbox_id);
		}
	}
	return { jobs, completedIds };
}

function acknowledgeMetadataOutbox(ids: readonly string[]): Promise<void> {
	return withTenant(REEMBED_ADMIN_TENANT, async (tx) => {
		await tx
			.delete(metadataReembedOutbox)
			.where(inArray(metadataReembedOutbox.id, [...ids]));
	});
}

/** Drain one committed snapshot, or every retained snapshot during startup. */
export function drainMetadataReembedOutbox(
	operationId?: string,
	pageSize = 100,
): Promise<{ enqueued: number; completed: number; failed: number }> {
	return drainMetadataReembedOutboxPagesWith(operationId, pageSize, {
		loadPage: loadMetadataOutboxPage,
		stagePage: stageMetadataOutboxPage,
		enqueueBulk: enqueueMetadataReembedPrepareJobsBulk,
		acknowledge: acknowledgeMetadataOutbox,
	});
}

type MetadataOutboxDrainResult = Awaited<
	ReturnType<typeof drainMetadataReembedOutbox>
>;

/** Start retained-work recovery without delaying worker readiness or API startup. */
export function startMetadataReembedOutboxRecovery(
	dependencies: Readonly<{
		drain?: () => Promise<MetadataOutboxDrainResult>;
		onComplete?: (result: MetadataOutboxDrainResult) => void;
		onError?: (error: unknown) => void;
	}> = {},
): void {
	const drain = dependencies.drain ?? (() => drainMetadataReembedOutbox());
	queueMicrotask(() => {
		void drain()
			.then((result) => {
				if (dependencies.onComplete) dependencies.onComplete(result);
				else
					logger.info(
						{ metadataOutbox: result },
						"Metadata outbox recovery completed",
					);
			})
			.catch((err) => {
				if (dependencies.onError) dependencies.onError(err);
				else
					logger.error(
						{ err },
						"Metadata outbox recovery deferred after startup failure",
					);
			});
	});
}

/** Start one post-commit drain without making a successful mutation depend on Redis. */
export function dispatchMetadataReembedOutbox(
	operationId: string | undefined,
	pageSize: number,
): void {
	if (!operationId) return;
	void drainMetadataReembedOutbox(operationId, pageSize).catch((err) => {
		logger.warn(
			{ err, operationId },
			"Metadata re-embed outbox dispatch deferred to recovery",
		);
	});
}

function safeReembedPageSize(configured: number, fallback: number): number {
	return configured > 0 ? configured : fallback;
}

export type MetadataReembedScope = "folder" | "category" | "tag";

/** @internal Resolve the configured bounded page size for one metadata domain. */
export function metadataReembedPageSize(scope: MetadataReembedScope): number {
	switch (scope) {
		case "folder":
			return safeReembedPageSize(config.FOLDER_REEMBED_BATCH_SIZE, 100);
		case "category":
			return safeReembedPageSize(config.CATEGORY_REEMBED_BATCH_SIZE, 100);
		case "tag":
			return safeReembedPageSize(config.TAG_REEMBED_BATCH_SIZE, 500);
	}
}

/**
 * Look up all documents attached to a folder and enqueue them for
 * re-embedding. `FOLDER_REEMBED_BATCH_SIZE` bounds each keyset page; the
 * helper continues until every matching document has been enqueued. A
 * configured `0` uses the safe default page size instead of an unbounded page.
 *
 * Used by `PATCH /api/folders/:id` (rename) and `DELETE /api/folders/:id`.
 *
 * @internal
 */
export async function reembedDocsInFolder(
	folderId: string,
	ownerId: string,
	workspaceId?: string,
): Promise<number> {
	const limit = metadataReembedPageSize("folder");
	const tenant: TenantContext = {
		userId: ownerId,
		role: "user",
		source: workspaceId ? "external" : "personal",
		workspaceId,
	};
	const snapshot = await withTenant(tenant, (tx) =>
		snapshotMetadataImpact(tx, tenant, { kind: "folder", id: folderId }),
	);
	const { enqueued, failed } = await drainMetadataReembedOutbox(
		snapshot.operationId,
		limit,
	);
	if (enqueued > 0) {
		logger.info(
			{ folderId, enqueued, failed, limit, targetCount: snapshot.targetCount },
			"Re-embedding documents after folder change",
		);
	}
	return enqueued;
}

/**
 * Operator-scope variant of `reembedDocsInFolder`. Used by the admin
 * `POST /api/admin/reindex/folder/:folderId` endpoint where the caller
 * is an ops script authenticated by `HIAI_DOCS_API_KEY` rather than a
 * user session - so `owner_id` filtering is not applicable.
 *
 * Reuses the same batch-cap and Redis dedup semantics as the
 * user-scoped helper. Cross-user by design: an operator reindex is
 * allowed to refresh documents across all owners.
 *
 * @internal
 */
export async function reembedDocsInFolderAdmin(
	folderId: string,
): Promise<number> {
	return reembedDocsInFolderAdminWith(folderId, loadAdminFolderDocumentIds);
}

type AdminFolderDocumentLoader = (
	folderId: string,
	cursor: string | undefined,
	limit: number,
) => Promise<Array<ReembedDocumentRow>>;

type AdminDocumentTarget = { id: string; workspaceId?: string };
type AdminDocumentLoader = (
	documentId: string,
) => Promise<AdminDocumentTarget | undefined>;

async function loadAdminFolderDocumentIds(
	folderId: string,
	cursor: string | undefined,
	limit: number,
): Promise<Array<ReembedDocumentRow>> {
	return withTenant(REEMBED_ADMIN_TENANT, (tx) => {
		const query = tx
			.select({
				id: documents.id,
				title: documents.title,
				content: documents.content,
			})
			.from(documents)
			.where(
				and(
					eq(documents.folderId, folderId),
					...(cursor ? [gt(documents.id, cursor)] : []),
				),
			)
			.orderBy(asc(documents.id));
		return limit > 0 ? query.limit(limit) : query;
	});
}

async function loadAdminDocumentTarget(
	documentId: string,
): Promise<AdminDocumentTarget | undefined> {
	const rows = await withTenant(REEMBED_ADMIN_TENANT, (tx) =>
		tx
			.select({ id: documents.id, workspaceId: documents.workspaceId })
			.from(documents)
			.where(eq(documents.id, documentId))
			.limit(1),
	);
	const row = rows[0];
	return row
		? { id: row.id, workspaceId: row.workspaceId ?? undefined }
		: undefined;
}

/** @internal Test seam for single-document operator reindex orchestration. */
export async function reembedDocumentAdminWith(
	documentId: string,
	loadTarget: AdminDocumentLoader,
): Promise<{ found: boolean; enqueued: number }> {
	const target = await loadTarget(documentId);
	if (!target) return { found: false, enqueued: 0 };
	const enqueued = await enqueueReembed([target.id], target.workspaceId, {
		bypassDedup: true,
		forceNewGeneration: true,
		source: "reindex",
		reason: "reindex",
		refreshMode: "full",
	});
	return { found: true, enqueued };
}

export function reembedDocumentAdmin(
	documentId: string,
): Promise<{ found: boolean; enqueued: number }> {
	return reembedDocumentAdminWith(documentId, loadAdminDocumentTarget);
}

/** @internal Test seam for the operator reindex orchestration. */
export async function reembedDocsInFolderAdminWith(
	folderId: string,
	loadRows: AdminFolderDocumentLoader,
): Promise<number> {
	const limit = metadataReembedPageSize("folder");
	const enqueued = await enqueueReembedPages(
		(cursor, pageLimit) => loadRows(folderId, cursor, pageLimit),
		limit,
		undefined,
		{
			bypassDedup: true,
			forceNewGeneration: true,
			reason: "reindex",
			refreshMode: "full",
			source: "reindex",
		},
	);
	if (enqueued > 0) {
		logger.info(
			{ folderId, enqueued, limit, scope: "admin" },
			"Re-embedding documents after admin folder reindex",
		);
	}
	return enqueued;
}

/**
 * Look up all documents whose `category_id` matches and enqueue them for
 * re-embedding. Same batch-cap semantics as `reembedDocsInFolder`. Used
 * by `PATCH /api/categories/:id` (rename) and `DELETE /api/categories/:id`.
 *
 * Delete routes snapshot affected documents before the foreign keys clear;
 * this helper serves rename and explicit reindex paths where category links
 * still exist. Direct assignments and folder-derived assignments share one
 * stable keyset pagination stream.
 *
 * @internal
 */
export async function reembedDocsInCategory(
	categoryId: string,
	ownerId: string,
	workspaceId?: string,
): Promise<number> {
	const limit = metadataReembedPageSize("category");

	const tenant: TenantContext = {
		userId: ownerId,
		role: "user",
		source: workspaceId ? "external" : "personal",
		workspaceId,
	};
	const snapshot = await withTenant(tenant, (tx) =>
		snapshotMetadataImpact(tx, tenant, {
			kind: "category",
			id: categoryId,
		}),
	);
	const { enqueued, failed } = await drainMetadataReembedOutbox(
		snapshot.operationId,
		limit,
	);

	if (enqueued > 0) {
		logger.info(
			{
				categoryId,
				enqueued,
				failed,
				limit,
				folderCount: snapshot.folderIds.length,
				targetCount: snapshot.targetCount,
			},
			"Re-embedding documents after category change",
		);
	}
	return enqueued;
}

/**
 * Look up every document linked to a tag via `documentTags` and enqueue
 * them for re-embedding. Used by `PATCH /api/tags/:id` (rename) and
 * `DELETE /api/tags/:id`.
 *
 * Tag batch cap is intentionally larger than folder/category because a
 * single tag can be attached to documents across many folders, which is
 * a common pattern (e.g. "draft" tag spans every folder).
 *
 * @internal
 */
export async function snapshotTagMetadataImpact(
	tx: TenantTransaction,
	ctx: TenantContext,
	tagId: string,
): Promise<Readonly<{ operationId: string; targetCount: number }>> {
	await acquireTenantTopologyLock(tx, ctx);
	const operationId = crypto.randomUUID();
	await tx.execute(sql`
		INSERT INTO public.metadata_reembed_outbox
			(id, operation_id, document_id, owner_id, workspace_id, revision, created_at)
		SELECT
			gen_random_uuid(),
			${operationId}::uuid,
			${documents.id},
			${documents.ownerId},
			${documents.workspaceId},
			encode(
				digest(${documents.title} || E'\n' || coalesce(${documents.content}, ''), 'sha256'),
				'hex'
			),
			statement_timestamp()
		FROM ${documentTags}
		JOIN ${documents} ON ${documents.id} = ${documentTags.documentId}
		WHERE ${and(
			eq(documentTags.tagId, tagId),
			tenantOwnerCondition(documents.ownerId, documents.workspaceId, ctx),
		)}
		ON CONFLICT (operation_id, document_id) DO NOTHING
	`);
	const [countRow] = await tx
		.select({ count: sql<number>`count(*)::int` })
		.from(metadataReembedOutbox)
		.where(eq(metadataReembedOutbox.operationId, operationId));
	return { operationId, targetCount: countRow?.count ?? 0 };
}

export async function reembedDocsByTag(
	tagId: string,
	ownerId?: string,
	workspaceId?: string,
): Promise<number> {
	const limit = metadataReembedPageSize("tag");
	let tenant: TenantContext;
	if (ownerId) {
		tenant = {
			userId: ownerId,
			role: "user",
			source: workspaceId ? "external" : "personal",
			workspaceId,
		};
	} else {
		const [tag] = await withTenant(REEMBED_ADMIN_TENANT, (tx) =>
			tx
				.select({ ownerId: tags.ownerId, workspaceId: tags.workspaceId })
				.from(tags)
				.where(eq(tags.id, tagId))
				.limit(1),
		);
		if (!tag) return 0;
		tenant = {
			userId: tag.ownerId,
			role: "user",
			source: tag.workspaceId ? "external" : "personal",
			workspaceId: tag.workspaceId ?? undefined,
		};
	}
	const snapshot = await withTenant(tenant, (tx) =>
		snapshotTagMetadataImpact(tx, tenant, tagId),
	);
	const { enqueued, failed } = await drainMetadataReembedOutbox(
		snapshot.operationId,
		limit,
	);
	if (enqueued > 0) {
		logger.info(
			{ tagId, enqueued, failed, limit, targetCount: snapshot.targetCount },
			"Re-embedding documents after tag change",
		);
	}
	return enqueued;
}
