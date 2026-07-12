import {
	documentEmbeddings,
	documentPipelineBatches,
	documentPipelineRuns,
	documents,
} from "@hiai-docs/db/schema";
import {
	adminTenantContext,
	withTenant,
	ZERO_UUID,
} from "@hiai-docs/db/with-tenant";
import { and, eq, sql } from "drizzle-orm";
import { activateEmbeddingGeneration } from "../embedding/generation";
import { getEmbedding } from "../embedding/index";
import { chunkHash } from "../lib/chunk-hash";
import { config } from "../lib/config";
import { extractEntities } from "../lib/graph/extract-entities";
import type { PipelineJob, PipelineStage } from "./contracts";
import { JOB_IDS } from "./contracts";
import { resolveDocumentRevision } from "./document-revision";
import { DEFAULT_JOB_OPTIONS, SOURCE_PRIORITY } from "./names";
import {
	type ProviderLimiterProfile,
	withProviderPermit,
} from "./provider-limiter";
import { getPipelineQueue } from "./queues";
import type { PipelineStageDependencies } from "./start";
import type { PipelineStageStatus } from "./workers/graph.worker";

const admin = adminTenantContext(ZERO_UUID);

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
			.where(eq(documentPipelineRuns.generationId, generationId)),
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
			.where(eq(documentPipelineRuns.generationId, generationId)),
	);
}

export function createPipelineStageDependencies(
	redisUrl: string,
): PipelineStageDependencies {
	const queue = (stage: PipelineStage) => getPipelineQueue(stage, redisUrl);
	return {
		prepare: {
			markStale: (job, errorCode) =>
				markRunStale(job.generationId, "prepare", errorCode),
			async loadDocument({ documentId, ownerId }) {
				return withTenant(admin, async (tx) => {
					const [doc] = await tx
						.select({
							title: documents.title,
							content: documents.content,
							revision: documents.contentHash,
						})
						.from(documents)
						.where(
							and(eq(documents.id, documentId), eq(documents.ownerId, ownerId)),
						)
						.limit(1);
					if (!doc) return null;
					return {
						title: doc.title,
						content: doc.content ?? "",
						revision: resolveDocumentRevision(
							doc.revision,
							doc.title,
							doc.content ?? "",
						),
					};
				});
			},
			async prepareRun({ job, totalChunks, batches }) {
				return withTenant(admin, async (tx) => {
					if ((batches.at(-1)?.chunkEnd ?? 0) !== totalChunks) {
						return "stale" as const;
					}
					const [run] = await tx
						.select({ status: documentPipelineRuns.prepareStatus })
						.from(documentPipelineRuns)
						.where(
							and(
								eq(documentPipelineRuns.generationId, job.generationId),
								eq(documentPipelineRuns.ownerId, job.ownerId),
								eq(documentPipelineRuns.revision, job.revision),
							),
						)
						.limit(1);
					if (!run) return "stale" as const;
					if (run.status === "ready") return "duplicate" as const;
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
							updatedAt: new Date(),
						})
						.where(eq(documentPipelineRuns.generationId, job.generationId));
					return "prepared" as const;
				});
			},
			enqueueEmbed(data, options) {
				return queue("embed").add("embed", data, options);
			},
		},
		embed: {
			markStale: (job, errorCode) =>
				markRunStale(job.generationId, "embed", errorCode),
			async loadDocument({ documentId, ownerId, generationId }) {
				return withTenant(admin, async (tx) => {
					const [doc] = await tx
						.select({
							title: documents.title,
							content: documents.content,
							revision: documents.contentHash,
							pendingGenerationId: documents.pendingEmbeddingGeneration,
						})
						.from(documents)
						.where(
							and(
								eq(documents.id, documentId),
								eq(documents.ownerId, ownerId),
								eq(documents.pendingEmbeddingGeneration, generationId),
							),
						)
						.limit(1);
					if (!doc) return null;
					return {
						title: doc.title,
						content: doc.content ?? "",
						revision: resolveDocumentRevision(
							doc.revision,
							doc.title,
							doc.content ?? "",
						),
						pendingGenerationId: doc.pendingGenerationId,
					};
				});
			},
			getEmbedding: (text) =>
				withProviderPermit(
					providerProfile(`embedding:${config.EMBEDDING_MODEL ?? "default"}`),
					"embed",
					() => getEmbedding(text),
				),
			async storeBatch({ job, rows }) {
				return withTenant(admin, async (tx) => {
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
					if (!batch) return "stale" as const;
					if (batch.status === "ready") return "duplicate" as const;
					await tx
						.insert(documentEmbeddings)
						.values(
							rows.map((row) => ({
								documentId: job.documentId,
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
				});
			},
			async completeBatch({ job, profile }) {
				return withTenant(admin, async (tx) => {
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
						.where(eq(documentPipelineRuns.generationId, job.generationId));
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
				);
				await setStageStatus(input.generationId, "embed", "ready");
			},
			enqueueGraph(data, options) {
				return queue("graph").add("graph", data, options);
			},
		},
		graph: {
			async getRun(job) {
				const run = await getRun(job.generationId);
				return run
					? {
							ownerId: run.ownerId,
							documentId: run.documentId,
							generationId: run.generationId,
							revision: run.revision,
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
								eq(documents.ownerId, job.ownerId),
							),
						)
						.limit(1);
					return row;
				});
				if (!doc) throw new Error("Pipeline document not found");
				await withProviderPermit(
					providerProfile(`graph:${config.GRAPH_EXTRACT_MODEL ?? "default"}`),
					"graph",
					() => extractEntities(doc.content ?? "", job.documentId),
				);
			},
			setGraphStatus: (generationId, status, errorCode) =>
				setStageStatus(generationId, "graph", status, errorCode),
		},
		summarize: {
			async getRun(job) {
				const run = await getRun(job.generationId);
				return run
					? {
							ownerId: run.ownerId,
							documentId: run.documentId,
							generationId: run.generationId,
							revision: run.revision,
							embedStatus: pipelineStageStatus(run.embedStatus),
						}
					: null;
			},
			enabled: () => false,
			async summarize() {},
			setSummaryStatus: (generationId, status, errorCode) =>
				setStageStatus(generationId, "summarize", status, errorCode),
			async enqueueFinalize(job) {
				const data: PipelineJob = { ...job, stage: "finalize" };
				await queue("finalize").add("finalize", data, {
					...DEFAULT_JOB_OPTIONS,
					jobId: JOB_IDS.finalize(job.generationId),
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
						.where(eq(documentPipelineRuns.generationId, generationId)),
				);
			},
		},
	};
}
