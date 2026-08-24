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
 * All functions here are best-effort:
 *   - They never throw. Redis or DB errors are logged and silently
 *     swallowed. A mutation route that calls us should NOT fail because
 *     the embedding enqueue did not go through - the user's data is
 *     already persisted and the embedding pipeline is enrichment.
 *   - A per-document Redis SET-NX slot (5s TTL) prevents rapid PATCH /
 *     toggle storms from queueing the same doc more than once in that
 *     window. The worker itself dedupes via `contentHash`, but the slot
 *     here saves the worker from processing redundant no-op updates.
 *
 * Exported surface is intentionally narrow - everything that is not part
 * of the public route-integration contract is kept module-private.
 */

import { documents, documentTags, folders } from "@hiai-docs/db/schema";
import {
	adminTenantContext,
	type TenantContext,
	type TenantTransaction,
	withTenant,
	ZERO_UUID,
} from "@hiai-docs/db/with-tenant";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
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
	documents: readonly ReembedTarget[];
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

function loadMetadataImpactDocumentPage(
	tx: TenantTransaction,
	ctx: TenantContext,
	target: MetadataImpactTarget,
	folderIds: readonly string[],
	cursor: string | undefined,
	limit: number,
): Promise<readonly ReembedDocumentRow[]> {
	const query = tx
		.select({
			id: documents.id,
			title: documents.title,
			content: documents.content,
		})
		.from(documents)
		.where(
			and(
				metadataImpactDocumentCondition(target, folderIds),
				...(cursor ? [gt(documents.id, cursor)] : []),
				tenantOwnerCondition(documents.ownerId, documents.workspaceId, ctx),
			),
		)
		.orderBy(asc(documents.id));
	return limit > 0 ? query.limit(limit) : query;
}

/** Resolve, optionally lock, and snapshot one metadata-impact domain. */
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
	const impactDocuments = await loadMetadataImpactDocumentPage(
		tx,
		ctx,
		target,
		folderIds,
		undefined,
		0,
	);
	return { folderIds, documents: impactDocuments.map(toReembedTarget) };
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
	const unique = new Map<string, { id: string; revision?: string }>();
	for (const target of docIds) {
		const id = typeof target === "string" ? target : target?.id;
		if (typeof id !== "string" || id.trim().length === 0) continue;
		const revision = typeof target === "string" ? undefined : target?.revision;
		if (revision !== undefined && revision.trim().length === 0) continue;
		const identity = revision
			? `${id}\u0000${revision}\u0000${refreshMode}\u0000${reason}`
			: id;
		unique.set(identity, { id, revision });
	}

	let pushed = 0;
	for (const { id, revision } of unique.values()) {
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
				},
			);
			if (queued) pushed += 1;
		}
	}
	return pushed;
}

/**
 * Look up all documents attached to a folder and enqueue them for
 * re-embedding. `FOLDER_REEMBED_BATCH_SIZE` bounds each keyset page; the
 * helper continues until every matching document has been enqueued. Set the
 * env var to `0` to load the complete result in one page.
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
	const limit = config.FOLDER_REEMBED_BATCH_SIZE;
	const tenant: TenantContext = {
		userId: ownerId,
		role: "user",
		source: workspaceId ? "external" : "personal",
		workspaceId,
	};
	const enqueued = await withTenant(tenant, async (tx) => {
		await acquireTenantTopologyLock(tx, tenant);
		const folderIds = await loadMetadataImpactFolderIds(tx, tenant, {
			kind: "folder",
			id: folderId,
		});
		return enqueueReembedPages(
			(cursor, pageLimit) =>
				loadMetadataImpactDocumentPage(
					tx,
					tenant,
					{ kind: "folder", id: folderId },
					folderIds,
					cursor,
					pageLimit,
				),
			limit,
			workspaceId,
			{ reason: "metadata", refreshMode: "full" },
		);
	});
	if (enqueued > 0) {
		logger.info(
			{ folderId, enqueued, limit },
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
	const limit = config.FOLDER_REEMBED_BATCH_SIZE;
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
	const limit = config.CATEGORY_REEMBED_BATCH_SIZE;

	const tenant: TenantContext = {
		userId: ownerId,
		role: "user",
		source: workspaceId ? "external" : "personal",
		workspaceId,
	};
	const { enqueued, folderCount } = await withTenant(tenant, async (tx) => {
		await acquireTenantTopologyLock(tx, tenant);
		const folderIds = await loadMetadataImpactFolderIds(tx, tenant, {
			kind: "category",
			id: categoryId,
		});
		const enqueued = await enqueueReembedPages(
			(cursor, pageLimit) =>
				loadMetadataImpactDocumentPage(
					tx,
					tenant,
					{ kind: "category", id: categoryId },
					folderIds,
					cursor,
					pageLimit,
				),
			limit,
			workspaceId,
			{ reason: "metadata", refreshMode: "full" },
		);
		return { enqueued, folderCount: folderIds.length };
	});

	if (enqueued > 0) {
		logger.info(
			{
				categoryId,
				enqueued,
				limit,
				folderCount,
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
export async function reembedDocsByTag(
	tagId: string,
	ownerId?: string,
	workspaceId?: string,
): Promise<number> {
	const limit = config.TAG_REEMBED_BATCH_SIZE;
	const tenant = ownerId
		? { userId: ownerId, role: "user" as const, workspaceId }
		: REEMBED_ADMIN_TENANT;
	const enqueued = await enqueueReembedPages(
		(cursor, pageLimit) =>
			withTenant(tenant, async (tx) => {
				const linkQuery = tx
					.selectDistinct({ documentId: documentTags.documentId })
					.from(documentTags)
					.where(
						and(
							eq(documentTags.tagId, tagId),
							...(cursor ? [gt(documentTags.documentId, cursor)] : []),
						),
					)
					.orderBy(asc(documentTags.documentId));
				const links =
					pageLimit > 0 ? await linkQuery.limit(pageLimit) : await linkQuery;
				if (links.length === 0) return [];
				const ids = links.map((row) => row.documentId);
				const rows = await tx
					.select({
						id: documents.id,
						title: documents.title,
						content: documents.content,
					})
					.from(documents)
					.where(inArray(documents.id, ids));
				const byId = new Map(rows.map((row) => [row.id, row]));
				return ids.flatMap((id) => {
					const row = byId.get(id);
					return row ? [row] : [];
				});
			}),
		limit,
		workspaceId,
		{ reason: "metadata", refreshMode: "full" },
	);
	if (enqueued > 0) {
		logger.info(
			{ tagId, enqueued, limit },
			"Re-embedding documents after tag change",
		);
	}
	return enqueued;
}
