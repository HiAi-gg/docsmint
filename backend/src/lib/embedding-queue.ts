import { documents } from "@hiai-docs/db/schema";
import {
	adminTenantContext,
	withTenant,
	ZERO_UUID,
} from "@hiai-docs/db/with-tenant";
import { and, eq, isNotNull, isNull, notInArray, or } from "drizzle-orm";
import type { PipelineSource } from "../queue/contracts";
import { enqueueDocumentPipeline } from "../queue/enqueue";
import { migrateLegacyEmbeddingEntries } from "../queue/legacy-bridge";
import { contentHash } from "./content-hash";
import { logger } from "./logger";
import { redis } from "./redis";

export const LEGACY_EMBEDDING_QUEUE_KEY = "hiai-docs:embedding-queue";

export async function enqueueEmbedding(
	documentId: string,
	source: PipelineSource = "interactive",
): Promise<boolean> {
	let pipelineInput: { ownerId: string; revision: string } | undefined;
	try {
		await withTenant(adminTenantContext(ZERO_UUID), async (tx) => {
			const rows = await tx
				.select({
					active: documents.activeEmbeddingGeneration,
					ownerId: documents.ownerId,
					title: documents.title,
					content: documents.content,
				})
				.from(documents)
				.where(eq(documents.id, documentId))
				.limit(1);
			const document = rows[0];
			if (!document) return;
			const revision = contentHash(document.title, document.content ?? "");
			pipelineInput = { ownerId: document.ownerId, revision };
			const activeGeneration = document.active;
			if (activeGeneration) {
				await tx
					.update(documents)
					.set({
						embeddingStatus: "stale",
						embeddingErrorCode: null,
						contentHash: revision,
					})
					.where(
						and(
							eq(documents.id, documentId),
							eq(documents.activeEmbeddingGeneration, activeGeneration),
						),
					);
			} else {
				await tx
					.update(documents)
					.set({ contentHash: revision })
					.where(eq(documents.id, documentId));
			}
		});
	} catch (err) {
		logger.warn(
			{ err, documentId },
			"Failed to mark embedding stale before enqueue",
		);
	}
	if (!pipelineInput) {
		logger.warn({ documentId }, "Document not found before pipeline enqueue");
		return false;
	}
	try {
		await enqueueDocumentPipeline({
			documentId,
			ownerId: pipelineInput.ownerId,
			revision: pipelineInput.revision,
			source,
		});
		return true;
	} catch (err) {
		logger.error({ err, documentId }, "Failed to enqueue embedding job");
		return false;
	}
}

/** One-release bridge: migrate legacy Redis-list IDs into durable runs. */
export function drainLegacyEmbeddingQueue(
	limit = 10_000,
): Promise<{ migrated: number; failed: number }> {
	return migrateLegacyEmbeddingEntries(
		() => redis.rpop(LEGACY_EMBEDDING_QUEUE_KEY),
		(documentId) => enqueueEmbedding(documentId, "backfill"),
		limit,
	);
}

/** Mark active generations whose profile differs from the running profile. */
export async function markStaleEmbeddingProfiles(
	currentProfiles: string | readonly string[],
): Promise<number> {
	const profiles =
		typeof currentProfiles === "string"
			? [currentProfiles]
			: [...currentProfiles];
	if (profiles.length === 0) return 0;
	return withTenant(adminTenantContext(ZERO_UUID), async (tx) => {
		const profileMismatch = or(
			isNull(documents.embeddingProfile),
			notInArray(documents.embeddingProfile, profiles),
		);
		const rows = await tx
			.select({ id: documents.id })
			.from(documents)
			.where(
				and(isNotNull(documents.activeEmbeddingGeneration), profileMismatch),
			);
		if (rows.length === 0) return 0;
		await tx
			.update(documents)
			.set({ embeddingStatus: "stale", embeddingErrorCode: null })
			.where(
				and(isNotNull(documents.activeEmbeddingGeneration), profileMismatch),
			);
		return rows.length;
	});
}
