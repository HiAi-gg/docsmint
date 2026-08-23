import type { PipelineJob, PipelineStage } from "./contracts";
import { JOB_IDS, PIPELINE_SCHEMA_VERSION } from "./contracts";
import { DEFAULT_JOB_OPTIONS, SOURCE_PRIORITY } from "./names";
import { getPipelineQueue } from "./queues";

export type FailureDisposition = {
	code: string;
	retryable: boolean;
};

export function classifyPipelineError(error: unknown): FailureDisposition {
	if (!error || typeof error !== "object")
		return { code: "unknown", retryable: false };
	const value = error as {
		code?: string;
		status?: number;
		name?: string;
		message?: string;
	};
	const code = (value.code ?? value.name ?? "worker_error").slice(0, 64);
	const status = value.status;
	const retryable =
		value.code === "provider_circuit_open" ||
		value.name === "AbortError" ||
		status === 408 ||
		status === 429 ||
		(typeof status === "number" && status >= 500) ||
		/timeout|ECONNRESET|ECONNREFUSED|redis/i.test(value.message ?? "");
	return { code, retryable };
}

export interface RecoverablePipelineJob {
	runId: string;
	stage: PipelineStage;
	job: PipelineJob;
	attempts: number;
	/** Optimistic-lock token captured by the stale scan. */
	observedUpdatedAt: Date;
}

export interface RecoveryStore {
	findStalled(input: {
		staleBefore: Date;
		limit: number;
	}): Promise<RecoverablePipelineJob[]>;
	claimRetry(input: {
		runId: string;
		stage: PipelineStage;
		maxAttempts: number;
		observedUpdatedAt: Date;
	}): Promise<boolean>;
	markExhausted(input: {
		runId: string;
		stage: PipelineStage;
		errorCode: string;
	}): Promise<void>;
}

export interface RecoveryQueueWriter {
	add(
		stage: PipelineStage,
		name: string,
		job: PipelineJob,
		options: Record<string, unknown>,
	): Promise<unknown>;
}

function jobId(job: PipelineJob): string {
	switch (job.stage) {
		case "prepare":
			return JOB_IDS.prepare(job.documentId, job.generationId, job.workspaceId);
		case "embed":
			return JOB_IDS.embed(job.generationId, job.batchIndex, job.workspaceId);
		case "graph":
			return JOB_IDS.graph(job.generationId, job.workspaceId);
		case "summarize":
			return JOB_IDS.summarize(job.generationId, job.workspaceId);
		case "finalize":
			return JOB_IDS.finalize(job.generationId, job.workspaceId);
	}
}

export async function recoverStalledPipeline(
	store: RecoveryStore,
	queues: RecoveryQueueWriter,
	options: {
		staleAfterMs?: number;
		limit?: number;
		maxAttempts?: number;
		now?: Date;
	} = {},
): Promise<{ recovered: number; exhausted: number }> {
	const now = options.now ?? new Date();
	const maxAttempts = options.maxAttempts ?? 5;
	const jobs = await store.findStalled({
		staleBefore: new Date(now.getTime() - (options.staleAfterMs ?? 120_000)),
		limit: options.limit ?? 100,
	});
	let recovered = 0;
	let exhausted = 0;
	for (const candidate of jobs) {
		if (candidate.attempts >= maxAttempts) {
			await store.markExhausted({
				runId: candidate.runId,
				stage: candidate.stage,
				errorCode: "recovery_attempts_exhausted",
			});
			exhausted += 1;
			continue;
		}
		if (
			!(await store.claimRetry({
				runId: candidate.runId,
				stage: candidate.stage,
				maxAttempts,
				observedUpdatedAt: candidate.observedUpdatedAt,
			}))
		)
			continue;
		await queues.add(candidate.stage, candidate.stage, candidate.job, {
			...DEFAULT_JOB_OPTIONS,
			jobId: jobId(candidate.job),
			priority: SOURCE_PRIORITY[candidate.job.source],
		});
		recovered += 1;
	}
	return { recovered, exhausted };
}

const admin = adminTenantContext(ZERO_UUID);
const stalled = ["pending", "processing", "retrying"] as const;
const active = ["processing", "retrying"] as const;

export function selectRecoveryStage(
	run: Pick<
		typeof documentPipelineRuns.$inferSelect,
		| "status"
		| "prepareStatus"
		| "embedStatus"
		| "graphStatus"
		| "summarizeStatus"
		| "finalizeStatus"
		| "generationId"
	>,
	document?: {
		activeGenerationId: string | null;
		pendingGenerationId: string | null;
	},
): PipelineStage | null {
	// The run is committed before Queue.add. Redis loss at that boundary leaves
	// a pending run without a job. Only prepare is eligible here: pending
	// downstream stages are normal and must wait for their predecessor.
	if (run.status === "pending" && run.prepareStatus === "pending")
		return "prepare";
	if (active.includes(run.prepareStatus as (typeof active)[number]))
		return "prepare";
	if (active.includes(run.embedStatus as (typeof active)[number]))
		return "embed";
	if (
		run.embedStatus === "ready" &&
		document?.pendingGenerationId === run.generationId &&
		document.activeGenerationId !== run.generationId
	)
		return "embed";
	if (active.includes(run.graphStatus as (typeof active)[number]))
		return "graph";
	if (active.includes(run.summarizeStatus as (typeof active)[number]))
		return "summarize";
	if (active.includes(run.finalizeStatus as (typeof active)[number]))
		return "finalize";
	return null;
}

export const postgresRecoveryStore: RecoveryStore = {
	async findStalled({ staleBefore, limit }) {
		return withTenant(admin, async (tx) => {
			const runs = await tx
				.select()
				.from(documentPipelineRuns)
				.where(
					and(
						inArray(documentPipelineRuns.status, [...stalled]),
						lt(documentPipelineRuns.updatedAt, staleBefore),
					),
				)
				.limit(limit);
			const output: RecoverablePipelineJob[] = [];
			for (const run of runs) {
				const [document] = await tx
					.select({
						activeGenerationId: documents.activeEmbeddingGeneration,
						pendingGenerationId: documents.pendingEmbeddingGeneration,
					})
					.from(documents)
					.where(eq(documents.id, run.documentId))
					.limit(1);
				const stage = selectRecoveryStage(run, document);
				if (!stage) continue;
				const base = {
					schemaVersion: PIPELINE_SCHEMA_VERSION,
					documentId: run.documentId,
					ownerId: run.ownerId,
					workspaceId: run.workspaceId ?? undefined,
					generationId: run.generationId,
					revision: run.revision,
					requestedAt: run.requestedAt.toISOString(),
					source: run.source as PipelineJob["source"],
					refreshMode:
						run.refreshMode === "incremental"
							? ("incremental" as const)
							: ("full" as const),
					embeddingContextHash: run.embeddingContextHash ?? undefined,
				};
				if (stage === "embed") {
					const activationRetry =
						run.embedStatus === "ready" &&
						document?.pendingGenerationId === run.generationId;
					const batches = await tx
						.select()
						.from(documentPipelineBatches)
						.where(
							and(
								eq(documentPipelineBatches.generationId, run.generationId),
								inArray(
									documentPipelineBatches.status,
									activationRetry ? ["ready"] : [...active],
								),
							),
						)
						.orderBy(desc(documentPipelineBatches.batchIndex))
						.limit(activationRetry ? 1 : 100);
					for (const batch of batches)
						output.push({
							runId: run.id,
							stage,
							attempts: Math.max(run.attempts, batch.attempts),
							observedUpdatedAt: run.updatedAt,
							job: {
								...base,
								stage,
								batchIndex: batch.batchIndex,
								totalBatches: run.totalBatches,
								chunkIndexes: Array.from(
									{ length: batch.chunkEnd - batch.chunkStart },
									(_, i) => batch.chunkStart + i,
								),
							},
						});
				} else {
					output.push({
						runId: run.id,
						stage,
						attempts: run.attempts,
						observedUpdatedAt: run.updatedAt,
						job: { ...base, stage },
					});
				}
			}
			return output;
		});
	},
	async claimRetry({ runId, stage, maxAttempts, observedUpdatedAt }) {
		return withTenant(admin, async (tx) => {
			const stagePatch =
				stage === "prepare"
					? { prepareStatus: "retrying" as const }
					: stage === "embed"
						? { embedStatus: "retrying" as const }
						: stage === "graph"
							? { graphStatus: "retrying" as const }
							: stage === "summarize"
								? { summarizeStatus: "retrying" as const }
								: { finalizeStatus: "retrying" as const };
			const rows = await tx
				.update(documentPipelineRuns)
				.set({
					...stagePatch,
					status: "retrying",
					attempts: sql`${documentPipelineRuns.attempts} + 1`,
					heartbeatAt: new Date(),
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(documentPipelineRuns.id, runId),
						lt(documentPipelineRuns.attempts, maxAttempts),
						eq(documentPipelineRuns.updatedAt, observedUpdatedAt),
					),
				)
				.returning({ id: documentPipelineRuns.id });
			return rows.length === 1;
		});
	},
	async markExhausted({ runId, stage, errorCode }) {
		await withTenant(admin, (tx) =>
			tx
				.update(documentPipelineRuns)
				.set({
					status: "failed",
					errorCode,
					...(stage === "prepare"
						? { prepareStatus: "failed" as const }
						: stage === "embed"
							? { embedStatus: "failed" as const }
							: stage === "graph"
								? { graphStatus: "failed" as const }
								: stage === "summarize"
									? { summarizeStatus: "failed" as const }
									: { finalizeStatus: "failed" as const }),
					updatedAt: new Date(),
				})
				.where(eq(documentPipelineRuns.id, runId)),
		);
	},
};

export function createBullMqRecoveryWriter(
	redisUrl: string,
): RecoveryQueueWriter {
	return {
		add(stage, name, job, options) {
			return getPipelineQueue(stage, redisUrl).add(name, job, options);
		},
	};
}

import {
	documentPipelineBatches,
	documentPipelineRuns,
	documents,
} from "@hiai-docs/db/schema";
import {
	adminTenantContext,
	withTenant,
	ZERO_UUID,
} from "@hiai-docs/db/with-tenant";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
