import { documents, folders, shareLinks } from "@hiai-docs/db/schema";
import { eq } from "drizzle-orm";
import type { TenantContext } from "../api/middleware/tenant";
import { withTenant } from "./with-tenant";

/**
 * Walk a folder's parent chain to determine if it sits under (or is)
 * `rootFolderId`. Cycles are guarded with a visited set so a corrupted
 * `parent_id` can't spin the helper forever.
 */
async function isFolderDescendant(
	ctx: TenantContext,
	targetFolderId: string,
	rootFolderId: string,
): Promise<boolean> {
	if (targetFolderId === rootFolderId) return true;
	let currentId: string | null = targetFolderId;
	const visited = new Set<string>();
	while (currentId && currentId !== rootFolderId && !visited.has(currentId)) {
		visited.add(currentId);
		const lookupId: string = currentId;
		const row: { parentId: string | null } | null = await withTenant(
			ctx,
			async (tx) => {
				const [r] = await tx
					.select({ parentId: folders.parentId })
					.from(folders)
					.where(eq(folders.id, lookupId))
					.limit(1);
				return r ?? null;
			},
		);
		if (!row) return false;
		currentId = row.parentId;
	}
	return currentId === rootFolderId;
}

/**
 * Check whether a share-link token grants access to a specific document.
 * Returns:
 *   - "granted" — token is valid (not expired) and matches the document
 *     either directly (shareLinks.documentId) or via an enclosing folder
 *     (shareLinks.folderId is an ancestor of the document's folder).
 *   - "expired" — token exists but the expiry check failed.
 *   - "missing" — no share link with that token.
 *   - "no-access" — token is valid but does not grant access to this doc.
 *
 * This helper intentionally does NOT enforce the `passwordHash` check: the
 * raw attachment endpoint serves binary image bytes that the browser will
 * load via `<img src=...>` and therefore cannot carry an
 * `x-share-password` header. Password-protected shares are an interactive
 * flow — the share-view page gates them with a password form before
 * rendering content — and by the time images load, the user has already
 * authenticated. If we want password-gated images in the future we'd add
 * a separate signed URL flow; this helper is the read-side primitive.
 */
export async function shareTokenAccessForDocument(
	ctx: TenantContext,
	documentId: string,
	token: string,
): Promise<"granted" | "expired" | "missing" | "no-access"> {
	const link = await withTenant(ctx, async (tx) => {
		const [row] = await tx
			.select()
			.from(shareLinks)
			.where(eq(shareLinks.token, token))
			.limit(1);
		return row ?? null;
	});
	if (!link) return "missing";
	if (link.expiresAt && link.expiresAt < new Date()) return "expired";

	if (link.documentId === documentId) return "granted";

	if (link.folderId) {
		const doc = await withTenant(ctx, async (tx) => {
			const [row] = await tx
				.select({ folderId: documents.folderId })
				.from(documents)
				.where(eq(documents.id, documentId))
				.limit(1);
			return row ?? null;
		});
		if (
			doc?.folderId &&
			(await isFolderDescendant(ctx, doc.folderId, link.folderId))
		) {
			return "granted";
		}
	}

	return "no-access";
}
