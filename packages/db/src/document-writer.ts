import { and, eq, inArray, isNull } from "drizzle-orm";

import type { Database } from "./client";
import { documents, versions } from "./schema";

export interface UpdateDocumentWithVersionInput {
	documentId: string;
	workspaceId: string;
	actorUserId: string;
	content: string;
	contentJson: unknown;
}

export interface CreateDocumentWithVersionInput {
	ownerId: string;
	workspaceId: string;
	title: string;
	content: string;
	contentJson: unknown;
	visibility: "private" | "shared" | "public";
	folderId?: string | null;
	categoryId?: string | null;
	metadata?: Record<string, unknown>;
}

/**
 * Public transaction-aware document mutations for product hosts that must
 * commit their own durable lease/ledger rows atomically with OSS documents.
 * Callers remain responsible for requesting index refresh after commit.
 */
export async function updateDocumentWithVersion(
	tx: Database,
	input: UpdateDocumentWithVersionInput,
): Promise<{ id: string } | null> {
	const changedAt = new Date();
	const [updated] = await tx
		.update(documents)
		.set({
			content: input.content,
			contentJson: input.contentJson,
			updatedAt: changedAt,
			metadataChangedAt: changedAt,
		})
		.where(
			and(
				eq(documents.id, input.documentId),
				eq(documents.workspaceId, input.workspaceId),
				isNull(documents.deletedAt),
			),
		)
		.returning({ id: documents.id });
	if (!updated) return null;
	await tx.insert(versions).values({
		documentId: input.documentId,
		workspaceId: input.workspaceId,
		content: input.content,
		contentJson: input.contentJson,
		createdBy: input.actorUserId,
	});
	return updated;
}

export async function createDocumentWithVersion(
	tx: Database,
	input: CreateDocumentWithVersionInput,
): Promise<{ id: string } | null> {
	const [created] = await tx
		.insert(documents)
		.values({
			ownerId: input.ownerId,
			workspaceId: input.workspaceId,
			title: input.title,
			content: input.content,
			contentJson: input.contentJson,
			visibility: input.visibility,
			folderId: input.folderId ?? null,
			categoryId: input.categoryId ?? null,
			metadata: input.metadata,
			metadataChangedAt: new Date(),
		})
		.returning({ id: documents.id });
	if (!created) return null;
	await tx.insert(versions).values({
		documentId: created.id,
		workspaceId: input.workspaceId,
		content: input.content,
		contentJson: input.contentJson,
		createdBy: input.ownerId,
	});
	return created;
}

export async function trashDocuments(
	tx: Database,
	input: { workspaceId: string; documentIds: readonly string[] },
): Promise<Array<{ id: string }>> {
	if (input.documentIds.length === 0) return [];
	return tx
		.update(documents)
		.set({ deletedAt: new Date(), updatedAt: new Date() })
		.where(
			and(
				eq(documents.workspaceId, input.workspaceId),
				inArray(documents.id, [...input.documentIds]),
				isNull(documents.deletedAt),
			),
		)
		.returning({ id: documents.id });
}
