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
	withTenant,
	ZERO_UUID,
} from "@hiai-docs/db/with-tenant";
import { and, eq, inArray } from "drizzle-orm";
import { config } from "./config";
import { enqueueEmbedding } from "./embedding-queue";
import { logger } from "./logger";
import { redis } from "./redis";

/**
 * Per-doc dedup slot prefix. Combined with a 5-second TTL this absorbs
 * rapid PATCH / toggle storms on the same doc - long enough to coalesce
 * auto-save keystrokes and rapid tag toggles, short enough that a real
 * follow-up edit (after a human-readable pause) still goes through.
 */
const DEDUP_KEY_PREFIX = "hiai-docs:reembed:dedup:";
const DEDUP_TTL_SECONDS = 5;
const REEMBED_ADMIN_TENANT = adminTenantContext(ZERO_UUID);

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
async function claimEnqueueSlot(docId: string): Promise<boolean> {
	const key = `${DEDUP_KEY_PREFIX}${docId}`;
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
	docIds: Iterable<string | null | undefined>,
): Promise<number> {
	const unique = new Set<string>();
	for (const id of docIds) {
		if (typeof id !== "string" || id.trim().length === 0) continue;
		unique.add(id);
	}

	let pushed = 0;
	for (const id of unique) {
		if (await claimEnqueueSlot(id)) {
			enqueueEmbedding(id);
			pushed += 1;
		}
	}
	return pushed;
}

/**
 * Look up all documents attached to a folder and enqueue them for
 * re-embedding. The query is bounded by `FOLDER_REEMBED_BATCH_SIZE` so
 * a rename of a mega-folder cannot spike embedding costs in a single
 * tick - the remaining documents get refreshed on their next edit. Set
 * the env var to `0` to disable the cap.
 *
 * Used by `PATCH /api/folders/:id` (rename) and `DELETE /api/folders/:id`.
 *
 * @internal
 */
export async function reembedDocsInFolder(
	folderId: string,
	ownerId: string,
): Promise<number> {
	const limit = config.FOLDER_REEMBED_BATCH_SIZE;
	const rows = await withTenant({ userId: ownerId, role: "user" }, (tx) => {
		const query = tx
			.select({ id: documents.id })
			.from(documents)
			.where(
				and(eq(documents.folderId, folderId), eq(documents.ownerId, ownerId)),
			);
		return limit > 0 ? query.limit(limit) : query;
	});
	const enqueued = await enqueueReembed(rows.map((r) => r.id));
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
	const limit = config.FOLDER_REEMBED_BATCH_SIZE;
	const rows = await withTenant(REEMBED_ADMIN_TENANT, (tx) => {
		const query = tx
			.select({ id: documents.id })
			.from(documents)
			.where(eq(documents.folderId, folderId));
		return limit > 0 ? query.limit(limit) : query;
	});
	const enqueued = await enqueueReembed(rows.map((r) => r.id));
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
 * Category delete cascades to `documents.category_id` via `ON DELETE SET
 * NULL`, so by the time this helper runs most affected docs have already
 * lost their `category_id`. We therefore union two lookups:
 *   - docs whose `category_id` is still set to `categoryId` (rename path)
 *   - docs whose `category_id` WAS `categoryId` but is now NULL
 *     (post-cascade delete path)
 * Deduplication is handled by `enqueueReembed` via `Set` + Redis slot.
 *
 * @internal
 */
export async function reembedDocsInCategory(
	categoryId: string,
	ownerId: string,
): Promise<number> {
	const limit = config.CATEGORY_REEMBED_BATCH_SIZE;

	const [directRows, folderDocRows] = await withTenant(
		{ userId: ownerId, role: "user" },
		async (tx) => {
			const directRows = await tx
				.select({ id: documents.id })
				.from(documents)
				.where(
					and(
						eq(documents.categoryId, categoryId),
						eq(documents.ownerId, ownerId),
					),
				);
			const folderRows = await tx
				.select({ id: folders.id })
				.from(folders)
				.where(
					and(eq(folders.categoryId, categoryId), eq(folders.ownerId, ownerId)),
				);
			const folderIds = folderRows.map((row) => row.id);
			if (folderIds.length === 0) return [directRows, []] as const;
			const query = tx
				.select({ id: documents.id })
				.from(documents)
				.where(
					and(
						eq(documents.ownerId, ownerId),
						inArray(documents.folderId, folderIds),
					),
				);
			const folderDocs = limit > 0 ? await query.limit(limit) : await query;
			return [directRows, folderDocs] as const;
		},
	);

	const allIds = new Set<string>();
	for (const r of directRows) allIds.add(r.id);
	for (const r of folderDocRows) allIds.add(r.id);

	const idArray = Array.from(allIds);
	const bounded = limit > 0 ? idArray.slice(0, limit) : idArray;
	const enqueued = await enqueueReembed(bounded);

	if (enqueued > 0) {
		logger.info(
			{
				categoryId,
				enqueued,
				limit,
				directCount: directRows.length,
				viaFolders: folderDocRows.length,
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
): Promise<number> {
	const limit = config.TAG_REEMBED_BATCH_SIZE;
	const tenant = ownerId
		? { userId: ownerId, role: "user" as const }
		: REEMBED_ADMIN_TENANT;
	const rows = await withTenant(tenant, (tx) => {
		const query = tx
			.selectDistinct({ documentId: documentTags.documentId })
			.from(documentTags)
			.where(eq(documentTags.tagId, tagId));
		return limit > 0 ? query.limit(limit) : query;
	});
	const enqueued = await enqueueReembed(rows.map((r) => r.documentId));
	if (enqueued > 0) {
		logger.info(
			{ tagId, enqueued, limit },
			"Re-embedding documents after tag change",
		);
	}
	return enqueued;
}
