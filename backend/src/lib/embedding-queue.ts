import { documents } from "@hiai-docs/db/schema";
import {
	adminTenantContext,
	withTenant,
	ZERO_UUID,
} from "@hiai-docs/db/with-tenant";
import { and, eq, isNotNull, isNull, notInArray, or } from "drizzle-orm";
import { logger } from "./logger";
import { redis } from "./redis";

const QUEUE_KEY = "hiai-docs:embedding-queue";

export async function enqueueEmbedding(documentId: string): Promise<boolean> {
	try {
		await withTenant(adminTenantContext(ZERO_UUID), async (tx) => {
			const rows = await tx
				.select({ active: documents.activeEmbeddingGeneration })
				.from(documents)
				.where(eq(documents.id, documentId))
				.limit(1);
			const activeGeneration = rows[0]?.active;
			if (activeGeneration) {
				await tx
					.update(documents)
					.set({ embeddingStatus: "stale", embeddingErrorCode: null })
					.where(
						and(
							eq(documents.id, documentId),
							eq(documents.activeEmbeddingGeneration, activeGeneration),
						),
					);
			}
		});
	} catch (err) {
		logger.warn(
			{ err, documentId },
			"Failed to mark embedding stale before enqueue",
		);
	}
	try {
		await redis.lpush(QUEUE_KEY, documentId);
		return true;
	} catch (err) {
		logger.error({ err, documentId }, "Failed to enqueue embedding job");
		return false;
	}
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

export { startEmbeddingWorker } from "../embedding/worker";
