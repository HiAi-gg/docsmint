import { documentEmbeddings, documents } from "@hiai-docs/db/schema";
import {
	adminTenantContext,
	withTenant,
	ZERO_UUID,
} from "@hiai-docs/db/with-tenant";
import { and, eq, ne } from "drizzle-orm";

const WORKER_TENANT = adminTenantContext(ZERO_UUID);

export type EmbeddingGenerationProfile = {
	model: string;
	dimensions: number;
	profile: string;
};

export type GenerationFailureCode =
	| "incomplete"
	| "invalid_profile"
	| "provider_error"
	| "worker_error"
	| "unknown";

export type EmbeddingLifecycleState =
	| "pending"
	| "processing"
	| "ready"
	| "failed"
	| "stale";

const TRANSITIONS: Record<
	EmbeddingLifecycleState,
	readonly EmbeddingLifecycleState[]
> = {
	pending: ["processing"],
	processing: ["ready", "failed"],
	ready: ["stale", "processing"],
	failed: ["processing"],
	stale: ["processing"],
};

export function canTransition(
	from: EmbeddingLifecycleState,
	to: EmbeddingLifecycleState,
): boolean {
	return TRANSITIONS[from].includes(to);
}

function profileId(profile: EmbeddingGenerationProfile | string): string {
	return typeof profile === "string" ? profile : profile.profile;
}

/** Start a candidate generation without changing the active queryable one. */
export async function beginEmbeddingGeneration(
	documentId: string,
	_profile: EmbeddingGenerationProfile | string,
): Promise<string> {
	const generationId = crypto.randomUUID();
	await withTenant(WORKER_TENANT, async (tx) => {
		await tx
			.update(documents)
			.set({
				embeddingStatus: "processing",
				pendingEmbeddingGeneration: generationId,
				embeddingErrorCode: null,
			})
			.where(eq(documents.id, documentId));
	});
	return generationId;
}

/**
 * Atomically make a complete, profile-consistent candidate generation active.
 * Older rows are removed only after all validation and the document update
 * have succeeded in the same transaction.
 */
export async function activateEmbeddingGeneration(
	documentId: string,
	generationId: string,
	expectedChunks: number,
	profile?: EmbeddingGenerationProfile | string,
): Promise<void> {
	await withTenant(WORKER_TENANT, async (tx) => {
		const documentRows = await tx
			.select({ pending: documents.pendingEmbeddingGeneration })
			.from(documents)
			.where(eq(documents.id, documentId))
			.limit(1);
		if (documentRows[0]?.pending !== generationId) {
			throw new Error("generation_not_pending");
		}

		const rows = await tx
			.select({
				isValid: documentEmbeddings.isValid,
				embeddingProfile: documentEmbeddings.embeddingProfile,
			})
			.from(documentEmbeddings)
			.where(
				and(
					eq(documentEmbeddings.documentId, documentId),
					eq(documentEmbeddings.generationId, generationId),
				),
			);

		if (rows.length !== expectedChunks || rows.length === 0) {
			throw new Error("generation_incomplete");
		}
		const expectedProfile = profile
			? profileId(profile)
			: rows[0]?.embeddingProfile;
		if (
			!expectedProfile ||
			rows.some(
				(row) => !row.isValid || row.embeddingProfile !== expectedProfile,
			)
		) {
			throw new Error("generation_invalid_profile");
		}

		await tx
			.update(documents)
			.set({
				activeEmbeddingGeneration: generationId,
				pendingEmbeddingGeneration: null,
				embeddingProfile: expectedProfile,
				embeddingStatus: "ready",
				embeddingErrorCode: null,
				embeddingUpdatedAt: new Date(),
			})
			.where(eq(documents.id, documentId));

		await tx
			.delete(documentEmbeddings)
			.where(
				and(
					eq(documentEmbeddings.documentId, documentId),
					ne(documentEmbeddings.generationId, generationId),
				),
			);
	});
}

/** Fail a candidate while preserving the last active generation intact. */
export async function failEmbeddingGeneration(
	documentId: string,
	generationId: string,
	code: GenerationFailureCode | string,
): Promise<void> {
	const safeCode = code.slice(0, 64).replace(/[^a-zA-Z0-9_-]/g, "_");
	await withTenant(WORKER_TENANT, async (tx) => {
		await tx
			.delete(documentEmbeddings)
			.where(
				and(
					eq(documentEmbeddings.documentId, documentId),
					eq(documentEmbeddings.generationId, generationId),
				),
			);
		await tx
			.update(documents)
			.set({
				embeddingStatus: "failed",
				embeddingErrorCode: safeCode || "unknown",
				pendingEmbeddingGeneration: null,
			})
			.where(
				and(
					eq(documents.id, documentId),
					eq(documents.pendingEmbeddingGeneration, generationId),
				),
			);
	});
}
