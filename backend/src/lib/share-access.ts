import { documents, folders, shareLinks } from "@hiai-docs/db/schema";
import { and, eq, inArray } from "drizzle-orm";
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

export interface ShareDocumentScope {
	ownerId: string;
	documentIds: string[];
	passwordHash: string | null;
	expiresAt: Date | null;
}

export async function verifyShareScopePassword(
	scope: Pick<ShareDocumentScope, "passwordHash">,
	password: string | null,
	verify: (password: string, hash: string) => Promise<boolean> = Bun.password
		.verify,
): Promise<boolean> {
	if (!scope.passwordHash) return true;
	return password !== null && verify(password, scope.passwordHash);
}

export function documentReferencesAttachment(
	document: { content?: string | null; contentJson?: unknown },
	attachmentId: string,
): boolean {
	const path = `/api/attachments/${attachmentId}/raw`;
	return (
		(document.content?.includes(path) ?? false) ||
		JSON.stringify(document.contentJson ?? null).includes(path)
	);
}

export function documentReferencesRemoteImage(
	document: { content?: string | null; contentJson?: unknown },
	source: string,
): boolean {
	const visit = (value: unknown): boolean => {
		if (!value || typeof value !== "object") return false;
		if (Array.isArray(value)) return value.some(visit);
		const record = value as Record<string, unknown>;
		if (
			record.type === "image" &&
			record.attrs &&
			typeof record.attrs === "object" &&
			(record.attrs as Record<string, unknown>).src === source
		) {
			return true;
		}
		return Object.values(record).some(visit);
	};
	if (visit(document.contentJson)) return true;
	const markdown = document.content ?? "";
	for (const match of markdown.matchAll(
		/!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g,
	)) {
		if ((match[1] ?? match[2]) === source) return true;
	}
	return false;
}

/**
 * Resolve the complete document allow-list for an anonymous share token.
 * The token is looked up with an admin context, then the resulting document
 * set is read under the link owner's context. This keeps search channels and
 * AGE graph expansion inside the same explicit share boundary.
 */
export async function resolveShareDocumentScope(
	lookupCtx: TenantContext,
	token: string,
): Promise<ShareDocumentScope | null> {
	const link = await withTenant(lookupCtx, async (tx) => {
		const [row] = await tx
			.select({
				createdBy: shareLinks.createdBy,
				documentId: shareLinks.documentId,
				folderId: shareLinks.folderId,
				passwordHash: shareLinks.passwordHash,
				expiresAt: shareLinks.expiresAt,
			})
			.from(shareLinks)
			.where(eq(shareLinks.token, token))
			.limit(1);
		return row ?? null;
	});
	if (!link || (link.expiresAt && link.expiresAt < new Date())) return null;

	const ownerCtx = {
		userId: link.createdBy,
		role: "user" as const,
	};
	const folderIds = new Set<string>();
	if (link.folderId) {
		const ownerFolders = await withTenant(ownerCtx, async (tx) =>
			tx
				.select({ id: folders.id, parentId: folders.parentId })
				.from(folders)
				.where(eq(folders.ownerId, link.createdBy)),
		);
		const byParent = new Map<string | null, string[]>();
		for (const folder of ownerFolders) {
			const children = byParent.get(folder.parentId) ?? [];
			children.push(folder.id);
			byParent.set(folder.parentId, children);
		}
		const pending = [link.folderId];
		while (pending.length > 0) {
			const current = pending.pop();
			if (!current || folderIds.has(current)) continue;
			folderIds.add(current);
			pending.push(...(byParent.get(current) ?? []));
		}
	}
	if (!link.documentId && folderIds.size === 0) {
		return {
			ownerId: link.createdBy,
			documentIds: [],
			passwordHash: link.passwordHash,
			expiresAt: link.expiresAt,
		};
	}
	const rows = await withTenant(ownerCtx, async (tx) =>
		tx
			.select({ id: documents.id })
			.from(documents)
			.where(
				and(
					eq(documents.ownerId, link.createdBy),
					link.documentId
						? eq(documents.id, link.documentId)
						: inArray(documents.folderId, [...folderIds]),
				),
			),
	);
	return {
		ownerId: link.createdBy,
		documentIds: rows.map((row) => row.id),
		passwordHash: link.passwordHash,
		expiresAt: link.expiresAt,
	};
}

/**
 * Compatibility path for documents duplicated before attachment cloning was
 * introduced. Access is allowed only when the attachment belongs to the same
 * owner and an explicitly shared document contains its exact protected URL.
 */
export async function shareTokenReferencesAttachment(
	lookupCtx: TenantContext,
	token: string,
	attachmentId: string,
	attachmentOwnerId: string,
): Promise<boolean> {
	const scope = await resolveShareDocumentScope(lookupCtx, token);
	if (
		!scope ||
		scope.ownerId !== attachmentOwnerId ||
		scope.documentIds.length === 0
	) {
		return false;
	}
	const ownerCtx = { userId: scope.ownerId, role: "user" as const };
	const rows = await withTenant(ownerCtx, async (tx) =>
		tx
			.select({
				content: documents.content,
				contentJson: documents.contentJson,
			})
			.from(documents)
			.where(inArray(documents.id, scope.documentIds)),
	);
	return rows.some((document) =>
		documentReferencesAttachment(document, attachmentId),
	);
}
