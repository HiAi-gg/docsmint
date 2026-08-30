import {
	categories,
	documentEmbeddings,
	documentKnowledgeSummaries,
	documentPipelineBatches,
	documentPipelineRuns,
	documents,
	documentTags,
	folders,
	tags,
} from "@hiai-docs/db/schema";
import {
	adminTenantContext,
	withTenant,
	ZERO_UUID,
} from "@hiai-docs/db/with-tenant";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { activateEmbeddingGeneration } from "../embedding/generation";
import { getEmbedding } from "../embedding/index";
import { EMBEDDING_DIMENSIONS } from "../embedding/utils";
import { embeddingProfileId } from "../embedding/validation";
import { chunkHash } from "../lib/chunk-hash";
import { config } from "../lib/config";
import { tenantOwnerCondition, tenantOwnerSql } from "../lib/content-access";
import { acquireDocumentPipelineLock } from "../lib/document-pipeline-serialization";
import { deleteDocumentGraphGeneration } from "../lib/graph/delete-document-state";
import { extractEntities } from "../lib/graph/extract-entities";
import {
	buildKnowledgeSummary,
	runKnowledgeSummaryStage,
} from "../lib/knowledge-summary";
import { requestKnowledgeSummary } from "../lib/knowledge-summary-provider";
import type {
	EmbedBatchJob,
	PipelineJob,
	PipelineStage,
	PrepareJob,
} from "./contracts";
import { JOB_IDS, PIPELINE_SCHEMA_VERSION } from "./contracts";
import { resolveDocumentRevision } from "./document-revision";
import { DEFAULT_JOB_OPTIONS, SOURCE_PRIORITY } from "./names";
import {
	type ProviderLimiterProfile,
	withProviderPermit,
} from "./provider-limiter";
import { getPipelineQueue } from "./queues";
import type { PipelineStageDependencies } from "./start";
import type { PipelineStageStatus } from "./workers/graph.worker";
import { buildEmbeddingPreparation } from "./workers/prepare.worker";

const admin = adminTenantContext(ZERO_UUID);

function jobTenant(job: { ownerId: string; workspaceId?: string }) {
	return {
		userId: job.ownerId,
		role: "user" as const,
		source: job.workspaceId ? ("external" as const) : ("personal" as const),
		workspaceId: job.workspaceId,
	};
}

export const _metadataTenantContextForTests = jobTenant;

async function resolveMetadataFolderCategory(
	tx: { execute(query: ReturnType<typeof sql>): Promise<unknown> },
	job: { ownerId: string; workspaceId?: string },
	folderId: string,
): Promise<string | null | undefined> {
	const ctx = jobTenant(job);
	const rows = (await tx.execute(sql`
		WITH RECURSIVE ancestors AS (
			SELECT folders.id, folders.parent_id, folders.category_id
			FROM folders
			WHERE folders.id = ${folderId} AND ${tenantOwnerSql("folders", ctx)}
			UNION ALL
			SELECT f.id, f.parent_id, f.category_id
			FROM folders f JOIN ancestors a ON f.id = a.parent_id
			WHERE ${tenantOwnerSql("f", ctx)}
		)
		SELECT category_id FROM ancestors WHERE category_id IS NOT NULL LIMIT 1
	`)) as Array<{ category_id: string }>;
	if (rows.length > 0) return rows[0]?.category_id ?? null;
	const exists = (await tx.execute(sql`
		SELECT 1 FROM folders
		WHERE folders.id = ${folderId} AND ${tenantOwnerSql("folders", ctx)}
	`)) as unknown[];
	return exists.length > 0 ? null : undefined;
}

function providerProfile(name: string): ProviderLimiterProfile {
	return {
		name,
		mode: config.PROVIDER_LIMITER_MODE,
		maxConcurrency: config.PROVIDER_MAX_CONCURRENCY,
		requestsPerMinute:
			config.PROVIDER_LIMITER_MODE === "remote"
				? config.PROVIDER_REQUESTS_PER_MINUTE
				: 0,
		maxRetries: config.PROVIDER_MAX_RETRIES,
		baseBackoffMs: config.PROVIDER_RETRY_BASE_DELAY_MS,
		circuitFailureThreshold: config.PROVIDER_CIRCUIT_FAILURE_THRESHOLD,
		circuitCooldownMs: config.PROVIDER_CIRCUIT_COOLDOWN_MS,
	};
}

function configuredEmbeddingProvider() {
	const model =
		config.EMBEDDING_MODEL ??
		config.EMBEDDING_FALLBACK_MODEL ??
		config.EMBEDDING_FALLBACK_2_MODEL ??
		"";
	return {
		model,
		profile: embeddingProfileId(model, EMBEDDING_DIMENSIONS, "v1"),
		dimensions: EMBEDDING_DIMENSIONS,
		identity: JSON.stringify({
			primary: [config.EMBEDDING_BASE_URL ?? "", config.EMBEDDING_MODEL ?? ""],
			fallback: [
				config.EMBEDDING_FALLBACK_BASE_URL ?? "",
				config.EMBEDDING_FALLBACK_MODEL ?? "",
			],
			fallback_2: [
				config.EMBEDDING_FALLBACK_2_BASE_URL ?? "",
				config.EMBEDDING_FALLBACK_2_MODEL ?? "",
			],
			dimensions: EMBEDDING_DIMENSIONS,
			profileVersion: "v1",
		}),
	};
}

function selectRecoveryProfile(
	ready: boolean,
	configured: { model: string; profile: string; dimensions: number },
	candidate?: { model: string; profile: string; dimensions: number },
) {
	return ready && candidate ? candidate : configured;
}

export const _selectCandidateProfileForTests = selectRecoveryProfile;

async function loadPreparationSource(input: {
	documentId: string;
	ownerId: string;
	workspaceId?: string;
}) {
	return withTenant(
		{ ...admin, workspaceId: input.workspaceId },
		async (tx) => {
			const [doc] = await tx
				.select({
					title: documents.title,
					content: documents.content,
					revision: documents.contentHash,
					folderId: documents.folderId,
					categoryId: documents.categoryId,
					activeGenerationId: documents.activeEmbeddingGeneration,
					pendingGenerationId: documents.pendingEmbeddingGeneration,
					activeContextHash: documents.embeddingContextHash,
				})
				.from(documents)
				.where(
					and(
						eq(documents.id, input.documentId),
						tenantOwnerCondition(
							documents.ownerId,
							documents.workspaceId,
							input.workspaceId
								? jobTenant(input)
								: { userId: input.ownerId, role: "user" as const },
						),
					),
				)
				.limit(1);
			if (!doc) return null;

			const metadataCtx = jobTenant(input);
			const effectiveCategoryId =
				doc.categoryId ??
				(doc.folderId
					? await resolveMetadataFolderCategory(tx, input, doc.folderId)
					: null);
			const [folderRows, tagRows, categoryRows, activeRows] = await Promise.all(
				[
					doc.folderId
						? tx
								.select({ name: folders.name })
								.from(folders)
								.where(
									and(
										eq(folders.id, doc.folderId),
										tenantOwnerCondition(
											folders.ownerId,
											folders.workspaceId,
											metadataCtx,
										),
									),
								)
								.limit(1)
						: Promise.resolve([]),
					tx
						.select({ name: tags.name })
						.from(documentTags)
						.innerJoin(tags, eq(tags.id, documentTags.tagId))
						.where(
							and(
								eq(documentTags.documentId, input.documentId),
								input.workspaceId
									? eq(documentTags.workspaceId, input.workspaceId)
									: isNull(documentTags.workspaceId),
								tenantOwnerCondition(
									tags.ownerId,
									tags.workspaceId,
									metadataCtx,
								),
							),
						)
						.orderBy(asc(tags.name), asc(tags.id)),
					effectiveCategoryId
						? tx
								.select({ name: categories.name })
								.from(categories)
								.where(
									and(
										eq(categories.id, effectiveCategoryId),
										tenantOwnerCondition(
											categories.ownerId,
											categories.workspaceId,
											metadataCtx,
										),
									),
								)
								.limit(1)
						: Promise.resolve([]),
					doc.activeGenerationId
						? tx
								.select({
									chunkIndex: documentEmbeddings.chunkIndex,
									chunkHash: documentEmbeddings.chunkHash,
									embedding: documentEmbeddings.embedding,
									embeddingModel: documentEmbeddings.embeddingModel,
									embeddingProfile: documentEmbeddings.embeddingProfile,
									embeddingDimensions: documentEmbeddings.embeddingDimensions,
									isValid: documentEmbeddings.isValid,
								})
								.from(documentEmbeddings)
								.where(
									and(
										eq(documentEmbeddings.documentId, input.documentId),
										eq(documentEmbeddings.generationId, doc.activeGenerationId),
									),
								)
								.orderBy(asc(documentEmbeddings.chunkIndex))
						: Promise.resolve([]),
				],
			);
			return {
				title: doc.title,
				content: doc.content ?? "",
				revision: resolveDocumentRevision(
					doc.revision,
					doc.title,
					doc.content ?? "",
				),
				pendingGenerationId: doc.pendingGenerationId,
				activeGenerationId: doc.activeGenerationId,
				activeContextHash: doc.activeContextHash,
				activeRows,
				metadata: {
					folderName: folderRows[0]?.name,
					tagNames: tagRows.map((row) => row.name),
					categoryName: categoryRows[0]?.name,
				},
			};
		},
	);
}

function stagePatch(stage: PipelineStage, status: PipelineStageStatus) {
	if (stage === "prepare") return { prepareStatus: status };
	if (stage === "embed") return { embedStatus: status };
	if (stage === "graph") return { graphStatus: status };
	if (stage === "summarize") return { summarizeStatus: status };
	return { finalizeStatus: status };
}

function pipelineStageStatus(value: string): PipelineStageStatus {
	return value === "ready_with_warnings"
		? "failed"
		: (value as PipelineStageStatus);
}

async function getRun(generationId: string) {
	return withTenant(admin, async (tx) => {
		const [run] = await tx
			.select()
			.from(documentPipelineRuns)
			.where(eq(documentPipelineRuns.generationId, generationId))
			.limit(1);
		return run ?? null;
	});
}

async function isCurrentPipelineGeneration(job: {
	documentId: string;
	ownerId: string;
	workspaceId?: string;
	generationId: string;
	revision: string;
	embeddingContextHash?: string;
}): Promise<boolean> {
	return withTenant({ ...admin, workspaceId: job.workspaceId }, async (tx) => {
		const [current] = await tx
			.select({ id: documents.id })
			.from(documents)
			.innerJoin(
				documentPipelineRuns,
				and(
					eq(documentPipelineRuns.documentId, documents.id),
					eq(documentPipelineRuns.generationId, job.generationId),
				),
			)
			.where(
				and(
					eq(documents.id, job.documentId),
					eq(documents.activeEmbeddingGeneration, job.generationId),
					...(job.embeddingContextHash
						? [eq(documents.embeddingContextHash, job.embeddingContextHash)]
						: []),
					eq(documentPipelineRuns.revision, job.revision),
					ne(documentPipelineRuns.status, "cancelled"),
					ne(documentPipelineRuns.status, "failed"),
					tenantOwnerCondition(
						documents.ownerId,
						documents.workspaceId,
						jobTenant(job),
					),
				),
			)
			.limit(1);
		return Boolean(current);
	});
}

async function cancelStalePipelineRun(
	job: {
		generationId: string;
	},
	errorCode: "stale_revision" | "stale_context" = "stale_revision",
): Promise<void> {
	await withTenant(admin, (tx) =>
		tx
			.update(documentPipelineRuns)
			.set({
				status: "cancelled",
				graphStatus: "cancelled",
				summarizeStatus: "cancelled",
				finalizeStatus: "cancelled",
				errorCode,
				completedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(documentPipelineRuns.generationId, job.generationId),
					ne(documentPipelineRuns.status, "cancelled"),
				),
			),
	);
}

async function setStageStatus(
	generationId: string,
	stage: PipelineStage,
	status: PipelineStageStatus,
	errorCode?: string,
) {
	await withTenant(admin, (tx) =>
		tx
			.update(documentPipelineRuns)
			.set({
				...stagePatch(stage, status),
				...(errorCode ? { errorCode } : {}),
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(documentPipelineRuns.generationId, generationId),
					ne(documentPipelineRuns.status, "cancelled"),
				),
			),
	);
}

async function markRunStale(
	generationId: string,
	stage: "prepare" | "embed",
	errorCode: string,
) {
	await withTenant(admin, (tx) =>
		tx
			.update(documentPipelineRuns)
			.set({
				...stagePatch(stage, "failed"),
				status: "failed",
				errorCode,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(documentPipelineRuns.generationId, generationId),
					ne(documentPipelineRuns.status, "cancelled"),
				),
			),
	);
}

async function claimPendingBatches(
	job: PrepareJob | EmbedBatchJob,
	limit: number,
): Promise<EmbedBatchJob[]> {
	return withTenant({ ...admin, workspaceId: job.workspaceId }, async (tx) => {
		const [run] = await tx
			.select({
				totalBatches: documentPipelineRuns.totalBatches,
				status: documentPipelineRuns.status,
				refreshMode: documentPipelineRuns.refreshMode,
				embeddingContextHash: documentPipelineRuns.embeddingContextHash,
			})
			.from(documentPipelineRuns)
			.where(eq(documentPipelineRuns.generationId, job.generationId))
			.limit(1);
		if (!run || run.status === "cancelled" || limit < 1) return [];
		const candidates = await tx
			.select({
				batchIndex: documentPipelineBatches.batchIndex,
				chunkStart: documentPipelineBatches.chunkStart,
				chunkEnd: documentPipelineBatches.chunkEnd,
			})
			.from(documentPipelineBatches)
			.where(
				and(
					eq(documentPipelineBatches.generationId, job.generationId),
					eq(documentPipelineBatches.status, "pending"),
				),
			)
			.orderBy(documentPipelineBatches.batchIndex)
			.limit(limit);
		const claimed: EmbedBatchJob[] = [];
		for (const batch of candidates) {
			const rows = await tx
				.update(documentPipelineBatches)
				.set({
					status: "processing",
					startedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(documentPipelineBatches.generationId, job.generationId),
						eq(documentPipelineBatches.batchIndex, batch.batchIndex),
						eq(documentPipelineBatches.status, "pending"),
					),
				)
				.returning({ batchIndex: documentPipelineBatches.batchIndex });
			if (rows.length !== 1) continue;
			claimed.push({
				...job,
				schemaVersion: PIPELINE_SCHEMA_VERSION,
				refreshMode: run.refreshMode === "incremental" ? "incremental" : "full",
				embeddingContextHash: run.embeddingContextHash ?? undefined,
				stage: "embed",
				batchIndex: batch.batchIndex,
				totalBatches: run.totalBatches,
				chunkIndexes: Array.from(
					{ length: batch.chunkEnd - batch.chunkStart },
					(_, offset) => batch.chunkStart + offset,
				),
			});
		}
		return claimed;
	});
}

export function createPipelineStageDependencies(
	redisUrl: string,
): PipelineStageDependencies {
	const queue = (stage: PipelineStage) => getPipelineQueue(stage, redisUrl);
	const enqueueIfActive = async (
		stage: PipelineStage,
		name: string,
		data: PipelineJob,
		options: typeof DEFAULT_JOB_OPTIONS & { jobId: string; priority: number },
	) => {
		if ((await getRun(data.generationId))?.status === "cancelled") return null;
		const queued = await queue(stage).add(name, data, options);
		if ((await getRun(data.generationId))?.status !== "cancelled")
			return queued;
		try {
			await queued.remove();
		} catch (error) {
			const message = error instanceof Error ? error.message.toLowerCase() : "";
			if (
				!message.includes("locked") &&
				!message.includes("active") &&
				!message.includes("not found")
			)
				throw error;
		}
		return null;
	};
	return {
		prepare: {
			isCancelled: async (job) =>
				(await getRun(job.generationId))?.status === "cancelled",
			claimPendingBatches,
			markStale: (job, errorCode) =>
				markRunStale(job.generationId, "prepare", errorCode),
			async loadDocument(input) {
				const document = await loadPreparationSource(input);
				if (!document) return null;
				const provider = configuredEmbeddingProvider();
				return {
					...document,
					provider,
					providerIdentity: provider.identity,
				};
			},
			async prepareRun({
				job,
				totalChunks,
				embeddingContextHash,
				chunks,
				activeRows,
				providerChunkIndexes,
				reusableChunkIndexes,
				batches,
			}) {
				return withTenant(
					{ ...admin, workspaceId: job.workspaceId },
					async (tx) => {
						if ((batches.at(-1)?.chunkEnd ?? 0) !== totalChunks) {
							return "stale" as const;
						}
						await acquireDocumentPipelineLock(tx, job.documentId);
						const [run] = await tx
							.select({ status: documentPipelineRuns.prepareStatus })
							.from(documentPipelineRuns)
							.where(
								and(
									eq(documentPipelineRuns.generationId, job.generationId),
									tenantOwnerCondition(
										documentPipelineRuns.ownerId,
										documentPipelineRuns.workspaceId,
										jobTenant(job),
									),
									eq(documentPipelineRuns.revision, job.revision),
								),
							)
							.limit(1)
							.for("update");
						if (!run) return "stale" as const;
						if (run.status === "ready") return "duplicate" as const;
						if (run.status === "cancelled") return "stale" as const;
						const chunksByIndex = new Map(
							chunks.map((chunk) => [chunk.index, chunk]),
						);
						const activeByIndex = new Map(
							activeRows.map((row) => [row.chunkIndex, row]),
						);
						const reusableRows = reusableChunkIndexes.flatMap((index) => {
							const chunk = chunksByIndex.get(index);
							const activeRow = activeByIndex.get(index);
							if (!chunk || !activeRow?.embedding) return [];
							return [
								{
									documentId: job.documentId,
									workspaceId: job.workspaceId,
									generationId: job.generationId,
									chunkIndex: index,
									chunkText: chunk.storedChunkText,
									chunkHash: chunk.hash,
									charStart: chunk.charStart,
									charEnd: chunk.charEnd,
									embedding: activeRow.embedding,
									embeddingModel: activeRow.embeddingModel,
									embeddingProfile: activeRow.embeddingProfile,
									embeddingDimensions: activeRow.embeddingDimensions,
									isValid: true,
								},
							];
						});
						if (reusableRows.length > 0) {
							await tx
								.insert(documentEmbeddings)
								.values(reusableRows)
								.onConflictDoNothing();
						}
						await tx
							.update(documents)
							.set({
								pendingEmbeddingGeneration: job.generationId,
								embeddingStatus: "processing",
								embeddingErrorCode: null,
							})
							.where(
								and(
									eq(documents.id, job.documentId),
									eq(documents.ownerId, job.ownerId),
								),
							);
						if (batches.length > 0) {
							await tx
								.insert(documentPipelineBatches)
								.values(
									batches.map((batch) => ({
										documentId: job.documentId,
										workspaceId: job.workspaceId,
										generationId: job.generationId,
										batchIndex: batch.batchIndex,
										chunkStart: batch.chunkStart,
										chunkEnd: batch.chunkEnd,
									})),
								)
								.onConflictDoNothing();
						}
						await tx
							.update(documentPipelineRuns)
							.set({
								prepareStatus: "ready",
								embedStatus: "pending",
								status: "processing",
								totalBatches: batches.length,
								embeddingContextHash,
								refreshMode:
									providerChunkIndexes.length === totalChunks &&
									reusableChunkIndexes.length === 0
										? "full"
										: "incremental",
								updatedAt: new Date(),
							})
							.where(
								and(
									eq(documentPipelineRuns.generationId, job.generationId),
									ne(documentPipelineRuns.status, "cancelled"),
								),
							);
						return "prepared" as const;
					},
				);
			},
			async completeEmpty(job) {
				await withTenant(
					{ ...admin, workspaceId: job.workspaceId },
					async (tx) => {
						await acquireDocumentPipelineLock(tx, job.documentId);
						const [run] = await tx
							.select({ status: documentPipelineRuns.status })
							.from(documentPipelineRuns)
							.where(
								and(
									eq(documentPipelineRuns.generationId, job.generationId),
									eq(documentPipelineRuns.ownerId, job.ownerId),
								),
							)
							.limit(1)
							.for("update");
						if (!run || run.status === "cancelled") return;
						// A zero-chunk generation is still the newest source of truth.
						// Activate it without inventing a vector/profile, remove any
						// previous generation rows, and leave downstream optional stages
						// to mark themselves skipped.
						const activated = await tx
							.update(documents)
							.set({
								activeEmbeddingGeneration: job.generationId,
								pendingEmbeddingGeneration: null,
								embeddingProfile: null,
								embeddingContextHash: job.embeddingContextHash ?? null,
								embeddingStatus: "ready",
								embeddingErrorCode: null,
								embeddingUpdatedAt: new Date(),
							})
							.where(
								and(
									eq(documents.id, job.documentId),
									eq(documents.ownerId, job.ownerId),
									eq(documents.pendingEmbeddingGeneration, job.generationId),
								),
							)
							.returning({ id: documents.id });
						if (activated.length !== 1) return;
						await tx
							.delete(documentEmbeddings)
							.where(
								and(
									eq(documentEmbeddings.documentId, job.documentId),
									ne(documentEmbeddings.generationId, job.generationId),
								),
							);
						await tx
							.update(documentPipelineRuns)
							.set({
								embedStatus: "ready",
								completedBatches: 0,
								updatedAt: new Date(),
							})
							.where(eq(documentPipelineRuns.generationId, job.generationId));
					},
				);
			},
			enqueueEmbed(data, options) {
				return enqueueIfActive("embed", "embed", data, options);
			},
			enqueueGraph(data, options) {
				return enqueueIfActive("graph", "graph", data, options);
			},
		},
		embed: {
			isCancelled: async (job) =>
				(await getRun(job.generationId))?.status === "cancelled",
			claimPendingBatches,
			enqueueEmbed(data, options) {
				return enqueueIfActive("embed", "embed", data, options);
			},
			markStale: (job, errorCode) =>
				markRunStale(job.generationId, "embed", errorCode),
			async loadDocument(job) {
				const document = await loadPreparationSource(job);
				if (!document) return null;
				const run = await getRun(job.generationId);
				if (!run) return null;
				const provider = configuredEmbeddingProvider();
				const preparation = buildEmbeddingPreparation({
					title: document.title,
					content: document.content,
					metadata: document.metadata,
					providerIdentity: provider.identity,
				});
				return withTenant(
					{ ...admin, workspaceId: job.workspaceId },
					async (tx) => {
						const [batch] = await tx
							.select({ status: documentPipelineBatches.status })
							.from(documentPipelineBatches)
							.where(
								and(
									eq(documentPipelineBatches.generationId, job.generationId),
									eq(documentPipelineBatches.batchIndex, job.batchIndex),
								),
							)
							.limit(1);
						const candidateRows = await tx
							.select({
								chunkIndex: documentEmbeddings.chunkIndex,
								model: documentEmbeddings.embeddingModel,
								profile: documentEmbeddings.embeddingProfile,
								dimensions: documentEmbeddings.embeddingDimensions,
							})
							.from(documentEmbeddings)
							.where(
								and(
									eq(documentEmbeddings.documentId, job.documentId),
									eq(documentEmbeddings.generationId, job.generationId),
								),
							);
						return {
							title: document.title,
							content: document.content,
							revision: document.revision,
							pendingGenerationId: document.pendingGenerationId,
							activeGenerationId: document.activeGenerationId,
							embeddingContextHash: preparation.contextHash,
							metadataPreamble: preparation.metadataPreamble,
							candidateChunkIndexes: candidateRows.map((row) => row.chunkIndex),
							batchStatus: batch?.status === "ready" ? "ready" : "processing",
							profile: selectRecoveryProfile(
								batch?.status === "ready",
								provider,
								candidateRows[0],
							),
						};
					},
				);
			},
			getEmbedding: (text) =>
				withProviderPermit(
					providerProfile(`embedding:${config.EMBEDDING_MODEL ?? "default"}`),
					"embed",
					() => getEmbedding(text),
				),
			async storeBatch({ job, rows }) {
				return withTenant(
					{ ...admin, workspaceId: job.workspaceId },
					async (tx) => {
						const [run] = await tx
							.select({ status: documentPipelineRuns.status })
							.from(documentPipelineRuns)
							.where(eq(documentPipelineRuns.generationId, job.generationId))
							.limit(1)
							.for("update");
						const [batch] = await tx
							.select({ status: documentPipelineBatches.status })
							.from(documentPipelineBatches)
							.where(
								and(
									eq(documentPipelineBatches.generationId, job.generationId),
									eq(documentPipelineBatches.batchIndex, job.batchIndex),
								),
							)
							.limit(1);
						if (!batch || run?.status === "cancelled") return "stale" as const;
						if (
							batch.status === "ready" &&
							!(
								job.refreshMode === "full" &&
								job.embeddingContextHash === undefined
							)
						)
							return "duplicate" as const;
						if (rows.length > 0) {
							await tx.delete(documentEmbeddings).where(
								and(
									eq(documentEmbeddings.documentId, job.documentId),
									eq(documentEmbeddings.generationId, job.generationId),
									inArray(
										documentEmbeddings.chunkIndex,
										rows.map((row) => row.chunkIndex),
									),
								),
							);
						}
						await tx
							.insert(documentEmbeddings)
							.values(
								rows.map((row) => ({
									documentId: job.documentId,
									workspaceId: job.workspaceId,
									generationId: job.generationId,
									chunkIndex: row.chunkIndex,
									chunkText: row.chunkText,
									chunkHash: chunkHash(row.chunkText),
									charStart: row.charStart,
									charEnd: row.charEnd,
									embedding: row.embedding,
									embeddingModel: row.model,
									embeddingProfile: row.profile,
									embeddingDimensions: row.dimensions,
									isValid: true,
								})),
							)
							.onConflictDoNothing();
						return "stored" as const;
					},
				);
			},
			async completeBatch({ job, profile }) {
				return withTenant(admin, async (tx) => {
					const [run] = await tx
						.select({ status: documentPipelineRuns.status })
						.from(documentPipelineRuns)
						.where(
							and(
								eq(documentPipelineRuns.generationId, job.generationId),
								eq(documentPipelineRuns.ownerId, job.ownerId),
							),
						)
						.limit(1)
						.for("update");
					if (!run || run.status === "cancelled")
						return { allBatchesComplete: false, totalChunks: 0 };
					await tx
						.update(documentPipelineBatches)
						.set({
							status: "ready",
							embeddingProfile: profile.profile,
							completedAt: new Date(),
							updatedAt: new Date(),
						})
						.where(
							and(
								eq(documentPipelineBatches.generationId, job.generationId),
								eq(documentPipelineBatches.batchIndex, job.batchIndex),
							),
						);
					const [counts] = await tx
						.select({
							total: sql<number>`count(*)::int`,
							ready: sql<number>`count(*) filter (where ${documentPipelineBatches.status} = 'ready')::int`,
						})
						.from(documentPipelineBatches)
						.where(eq(documentPipelineBatches.generationId, job.generationId));
					const [chunks] = await tx
						.select({ total: sql<number>`count(*)::int` })
						.from(documentEmbeddings)
						.where(eq(documentEmbeddings.generationId, job.generationId));
					await tx
						.update(documentPipelineRuns)
						.set({
							completedBatches: counts?.ready ?? 0,
							embedStatus:
								(counts?.ready ?? 0) === (counts?.total ?? -1)
									? "ready"
									: "processing",
							updatedAt: new Date(),
						})
						.where(
							and(
								eq(documentPipelineRuns.generationId, job.generationId),
								ne(documentPipelineRuns.status, "cancelled"),
							),
						);
					return {
						allBatchesComplete:
							(counts?.total ?? 0) > 0 && counts?.ready === counts?.total,
						totalChunks: chunks?.total ?? 0,
					};
				});
			},
			async activateGeneration(input) {
				await activateEmbeddingGeneration(
					input.documentId,
					input.generationId,
					input.totalChunks,
					input.profile,
					input.embeddingContextHash,
				);
				await setStageStatus(input.generationId, "embed", "ready");
			},
			enqueueGraph(data, options) {
				return enqueueIfActive("graph", "graph", data, options);
			},
		},
		graph: {
			isCancelled: async (job) =>
				(await getRun(job.generationId))?.status === "cancelled",
			async getRun(job) {
				const run = await getRun(job.generationId);
				return run
					? {
							ownerId: run.ownerId,
							documentId: run.documentId,
							generationId: run.generationId,
							revision: run.revision,
							embeddingContextHash: run.embeddingContextHash ?? undefined,
							embedStatus: pipelineStageStatus(run.embedStatus),
						}
					: null;
			},
			async extract(job) {
				const doc = await withTenant(admin, async (tx) => {
					const [row] = await tx
						.select({ content: documents.content })
						.from(documents)
						.where(
							and(
								eq(documents.id, job.documentId),
								eq(documents.activeEmbeddingGeneration, job.generationId),
								eq(documents.contentHash, job.revision),
								...(job.embeddingContextHash
									? [
											eq(
												documents.embeddingContextHash,
												job.embeddingContextHash,
											),
										]
									: []),
								tenantOwnerCondition(
									documents.ownerId,
									documents.workspaceId,
									jobTenant(job),
								),
							),
						)
						.limit(1);
					return row;
				});
				if (!doc) throw new Error("Pipeline document not found");
				return withProviderPermit(
					providerProfile(`graph:${config.GRAPH_EXTRACT_MODEL ?? "default"}`),
					"graph",
					() =>
						extractEntities(doc.content ?? "", job.documentId, {
							generationId: job.generationId,
							revision: job.revision,
						}),
				);
			},
			async compensateExtract(job) {
				const owned = await withTenant(
					{ ...admin, workspaceId: job.workspaceId },
					async (tx) =>
						tx
							.select({ id: documents.id })
							.from(documents)
							.where(
								and(
									eq(documents.id, job.documentId),
									tenantOwnerCondition(
										documents.ownerId,
										documents.workspaceId,
										jobTenant(job),
									),
								),
							)
							.limit(1),
				);
				if (owned.length === 1)
					await deleteDocumentGraphGeneration(job.documentId, job.generationId);
			},
			cancelStaleRun: cancelStalePipelineRun,
			setGraphStatus: (generationId, status, errorCode) =>
				setStageStatus(generationId, "graph", status, errorCode),
			async enqueueSummarize(job) {
				const data: PipelineJob = { ...job, stage: "summarize" };
				await enqueueIfActive("summarize", "summarize", data, {
					...DEFAULT_JOB_OPTIONS,
					jobId: JOB_IDS.summarize(job.generationId, job.workspaceId),
					priority: SOURCE_PRIORITY[job.source],
				});
			},
		},
		summarize: {
			isCancelled: async (job) =>
				(await getRun(job.generationId))?.status === "cancelled",
			isCurrent: isCurrentPipelineGeneration,
			cancelStaleRun: cancelStalePipelineRun,
			async getRun(job) {
				const run = await getRun(job.generationId);
				return run
					? {
							ownerId: run.ownerId,
							documentId: run.documentId,
							generationId: run.generationId,
							revision: run.revision,
							embeddingContextHash: run.embeddingContextHash ?? undefined,
							embedStatus: pipelineStageStatus(run.embedStatus),
						}
					: null;
			},
			enabled: () =>
				config.GRAPH_EXTRACT_ENABLED &&
				Boolean(config.GRAPH_EXTRACT_BASE_URL && config.GRAPH_EXTRACT_MODEL),
			async summarize(job) {
				return runKnowledgeSummaryStage({
					readCurrent: () =>
						withTenant(
							{ ...admin, workspaceId: job.workspaceId },
							async (tx) => {
								const [document] = await tx
									.select({
										title: documents.title,
										content: documents.content,
										contentHash: documents.contentHash,
										activeGeneration: documents.activeEmbeddingGeneration,
									})
									.from(documents)
									.where(
										and(
											eq(documents.id, job.documentId),
											eq(documents.activeEmbeddingGeneration, job.generationId),
											...(job.embeddingContextHash
												? [
														eq(
															documents.embeddingContextHash,
															job.embeddingContextHash,
														),
													]
												: []),
											tenantOwnerCondition(
												documents.ownerId,
												documents.workspaceId,
												jobTenant(job),
											),
										),
									)
									.limit(1);
								if (!document) return null;
								const revision = resolveDocumentRevision(
									document.contentHash,
									document.title,
									document.content ?? "",
								);
								if (revision !== job.revision) return null;
								return {
									title: document.title,
									content: document.content ?? "",
									revision,
								};
							},
						),
					generate: (document) =>
						buildKnowledgeSummary(document, requestKnowledgeSummary),
					persistIfCurrent: (summary) =>
						withTenant(
							{ ...admin, workspaceId: job.workspaceId },
							async (tx) => {
								await acquireDocumentPipelineLock(tx, job.documentId);
								const [current] = await tx
									.select({ id: documents.id })
									.from(documents)
									.innerJoin(
										documentPipelineRuns,
										and(
											eq(documentPipelineRuns.documentId, documents.id),
											eq(documentPipelineRuns.generationId, job.generationId),
										),
									)
									.where(
										and(
											eq(documents.id, job.documentId),
											eq(documents.activeEmbeddingGeneration, job.generationId),
											eq(documents.contentHash, job.revision),
											eq(documentPipelineRuns.revision, job.revision),
											...(job.embeddingContextHash
												? [
														eq(
															documents.embeddingContextHash,
															job.embeddingContextHash,
														),
														eq(
															documentPipelineRuns.embeddingContextHash,
															job.embeddingContextHash,
														),
													]
												: []),
											eq(documentPipelineRuns.summarizeStatus, "processing"),
											ne(documentPipelineRuns.status, "cancelled"),
											ne(documentPipelineRuns.status, "failed"),
											tenantOwnerCondition(
												documents.ownerId,
												documents.workspaceId,
												jobTenant(job),
											),
										),
									)
									.limit(1)
									.for("update");
								if (!current) return false;
								await tx
									.insert(documentKnowledgeSummaries)
									.values({
										document_id: job.documentId,
										owner_id: job.ownerId,
										workspace_id: job.workspaceId,
										generation_id: job.generationId,
										revision: job.revision,
										language: summary.language,
										description: summary.description,
										keywords: summary.keywords,
										updated_at: new Date(),
									})
									.onConflictDoUpdate({
										target: [
											documentKnowledgeSummaries.document_id,
											documentKnowledgeSummaries.generation_id,
										],
										set: {
											revision: job.revision,
											language: summary.language,
											description: summary.description,
											keywords: summary.keywords,
											updated_at: new Date(),
										},
									});
								return true;
							},
						),
				});
			},
			setSummaryStatus: (generationId, status, errorCode) =>
				setStageStatus(generationId, "summarize", status, errorCode),
			async enqueueFinalize(job) {
				const data: PipelineJob = { ...job, stage: "finalize" };
				await enqueueIfActive("finalize", "finalize", data, {
					...DEFAULT_JOB_OPTIONS,
					jobId: JOB_IDS.finalize(job.generationId, job.workspaceId),
					priority: SOURCE_PRIORITY[job.source],
				});
			},
		},
		finalize: {
			async getRun(job) {
				const run = await getRun(job.generationId);
				return run
					? {
							ownerId: run.ownerId,
							documentId: run.documentId,
							generationId: run.generationId,
							revision: run.revision,
							embedStatus: pipelineStageStatus(run.embedStatus),
							status: pipelineStageStatus(run.status),
							graphStatus: pipelineStageStatus(run.graphStatus),
							summarizeStatus: pipelineStageStatus(run.summarizeStatus),
						}
					: null;
			},
			async setRunStatus(generationId, status, errorCode) {
				await withTenant(admin, (tx) =>
					tx
						.update(documentPipelineRuns)
						.set({
							status,
							finalizeStatus: status === "cancelled" ? "cancelled" : "ready",
							...(errorCode ? { errorCode } : {}),
							completedAt: new Date(),
							updatedAt: new Date(),
						})
						.where(
							and(
								eq(documentPipelineRuns.generationId, generationId),
								ne(documentPipelineRuns.status, "cancelled"),
							),
						),
				);
			},
		},
	};
}
