import { documents } from "@hiai-docs/db/schema";
import {
	adminTenantContext,
	withTenant,
	ZERO_UUID,
} from "@hiai-docs/db/with-tenant";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { logger } from "./logger";
import { redis } from "./redis";

const QUEUE_KEY = "hiai-docs:embedding-queue";

export function enqueueEmbedding(documentId: string): void {
	void withTenant(adminTenantContext(ZERO_UUID), async (tx) => {
		const rows = await tx
			.select({ active: documents.activeEmbeddingGeneration })
			.from(documents)
			.where(eq(documents.id, documentId))
			.limit(1);
		if (rows[0]?.active) {
			await tx
				.update(documents)
				.set({ embeddingStatus: "stale", embeddingErrorCode: null })
				.where(eq(documents.id, documentId));
		}
	}).catch((err) => {
		logger.warn(
			{ err, documentId },
			"Failed to mark embedding stale before enqueue",
		);
	});
	redis.lpush(QUEUE_KEY, documentId).catch((err) => {
		logger.error({ err, documentId }, "Failed to enqueue embedding job");
	});
}

/** Mark active generations whose profile differs from the running profile. */
export async function markStaleEmbeddingProfiles(
	currentProfile: string,
): Promise<number> {
	return withTenant(adminTenantContext(ZERO_UUID), async (tx) => {
		const rows = await tx
			.select({ id: documents.id })
			.from(documents)
			.where(
				and(
					isNotNull(documents.activeEmbeddingGeneration),
					ne(documents.embeddingProfile, currentProfile),
				),
			);
		if (rows.length === 0) return 0;
		await tx
			.update(documents)
			.set({ embeddingStatus: "stale", embeddingErrorCode: null })
			.where(
				and(
					isNotNull(documents.activeEmbeddingGeneration),
					ne(documents.embeddingProfile, currentProfile),
				),
			);
		return rows.length;
	});
}

export { startEmbeddingWorker } from "../embedding/worker";
