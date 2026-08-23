import { graphJobSchema, type PipelineJob } from "../contracts";
import { processGraphStageFailure } from "../stage-policies";

export type PipelineStageStatus =
	| "pending"
	| "processing"
	| "ready"
	| "retrying"
	| "failed"
	| "skipped"
	| "cancelled";

export interface GraphPipelineState {
	ownerId: string;
	documentId: string;
	generationId: string;
	revision: string;
	embeddingContextHash?: string;
	embedStatus: PipelineStageStatus;
}

export interface GraphWorkerDependencies {
	isCancelled?(job: ReturnType<typeof graphJobSchema.parse>): Promise<boolean>;
	getRun(
		job: ReturnType<typeof graphJobSchema.parse>,
	): Promise<GraphPipelineState | null>;
	extract(job: ReturnType<typeof graphJobSchema.parse>): Promise<void>;
	compensateExtract?(
		job: ReturnType<typeof graphJobSchema.parse>,
	): Promise<void>;
	cancelStaleRun(
		job: ReturnType<typeof graphJobSchema.parse>,
		errorCode?: "stale_revision" | "stale_context",
	): Promise<void>;
	setGraphStatus(
		generationId: string,
		status: PipelineStageStatus,
		errorCode?: string,
	): Promise<void>;
	enqueueSummarize(job: ReturnType<typeof graphJobSchema.parse>): Promise<void>;
}

/**
 * Graph is deliberately isolated from embedding activation. A graph failure
 * changes only graphStatus; the active embedding generation remains ready.
 */
export function createGraphWorker(deps: GraphWorkerDependencies) {
	return async function processGraphJob(input: PipelineJob): Promise<void> {
		const job = graphJobSchema.parse(input);
		if (await deps.isCancelled?.(job)) return;
		const run = await deps.getRun(job);
		if (!run) throw new Error("Pipeline run not found");
		if (run.ownerId !== job.ownerId || run.documentId !== job.documentId) {
			throw new Error("Pipeline owner mismatch");
		}
		if (
			run.generationId !== job.generationId ||
			run.revision !== job.revision
		) {
			await deps.setGraphStatus(
				job.generationId,
				"cancelled",
				"stale_revision",
			);
			await deps.cancelStaleRun(job, "stale_revision");
			return;
		}
		if (
			job.embeddingContextHash !== undefined &&
			run.embeddingContextHash !== job.embeddingContextHash
		) {
			await deps.setGraphStatus(job.generationId, "cancelled", "stale_context");
			await deps.cancelStaleRun(job, "stale_context");
			return;
		}
		if (run.embedStatus !== "ready") {
			if (await deps.isCancelled?.(job)) return;
			await deps.setGraphStatus(
				job.generationId,
				"skipped",
				"embedding_not_ready",
			);
			if (!(await deps.isCancelled?.(job))) await deps.enqueueSummarize(job);
			return;
		}

		if (await deps.isCancelled?.(job)) return;
		await deps.setGraphStatus(job.generationId, "processing");
		try {
			if (await deps.isCancelled?.(job)) return;
			await deps.extract(job);
			if (await deps.isCancelled?.(job)) {
				await deps.compensateExtract?.(job);
				return;
			}
			await deps.setGraphStatus(job.generationId, "ready");
			if (!(await deps.isCancelled?.(job))) await deps.enqueueSummarize(job);
		} catch (error) {
			await processGraphStageFailure(job, error, deps);
		}
	};
}
