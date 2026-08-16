import { type PipelineJob, summarizeJobSchema } from "../contracts";
import type { GraphPipelineState, PipelineStageStatus } from "./graph.worker";

export interface SummarizeWorkerDependencies {
	isCancelled?(
		job: ReturnType<typeof summarizeJobSchema.parse>,
	): Promise<boolean>;
	getRun(
		job: ReturnType<typeof summarizeJobSchema.parse>,
	): Promise<GraphPipelineState | null>;
	enabled(): boolean;
	summarize(
		job: ReturnType<typeof summarizeJobSchema.parse>,
	): Promise<"ready" | "skipped">;
	setSummaryStatus(
		generationId: string,
		status: PipelineStageStatus,
		errorCode?: string,
	): Promise<void>;
	enqueueFinalize(
		job: ReturnType<typeof summarizeJobSchema.parse>,
	): Promise<void>;
}

/** Summary is optional and never controls embedding or GraphRAG readiness. */
export function createSummarizeWorker(deps: SummarizeWorkerDependencies) {
	return async function processSummarizeJob(input: PipelineJob): Promise<void> {
		const job = summarizeJobSchema.parse(input);
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
			await deps.setSummaryStatus(
				job.generationId,
				"cancelled",
				"stale_revision",
			);
			return;
		}
		if (!deps.enabled()) {
			if (await deps.isCancelled?.(job)) return;
			await deps.setSummaryStatus(job.generationId, "skipped");
			if (!(await deps.isCancelled?.(job))) await deps.enqueueFinalize(job);
			return;
		}

		if (await deps.isCancelled?.(job)) return;
		await deps.setSummaryStatus(job.generationId, "processing");
		try {
			if (await deps.isCancelled?.(job)) return;
			const status = await deps.summarize(job);
			if (await deps.isCancelled?.(job)) return;
			await deps.setSummaryStatus(job.generationId, status);
		} catch (error) {
			if (await deps.isCancelled?.(job)) return;
			await deps.setSummaryStatus(
				job.generationId,
				"failed",
				error instanceof Error ? error.name : "summary_failed",
			);
			if (!(await deps.isCancelled?.(job))) await deps.enqueueFinalize(job);
			throw error;
		}
		if (!(await deps.isCancelled?.(job))) await deps.enqueueFinalize(job);
	};
}
