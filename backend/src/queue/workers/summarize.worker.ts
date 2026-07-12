import { type PipelineJob, summarizeJobSchema } from "../contracts";
import type { GraphPipelineState, PipelineStageStatus } from "./graph.worker";

export interface SummarizeWorkerDependencies {
	getRun(
		job: ReturnType<typeof summarizeJobSchema.parse>,
	): Promise<GraphPipelineState | null>;
	enabled(): boolean;
	summarize(job: ReturnType<typeof summarizeJobSchema.parse>): Promise<void>;
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
			await deps.setSummaryStatus(job.generationId, "skipped");
			await deps.enqueueFinalize(job);
			return;
		}

		await deps.setSummaryStatus(job.generationId, "processing");
		try {
			await deps.summarize(job);
			await deps.setSummaryStatus(job.generationId, "ready");
		} catch (error) {
			await deps.setSummaryStatus(
				job.generationId,
				"failed",
				error instanceof Error ? error.name : "summary_failed",
			);
			throw error;
		}
		await deps.enqueueFinalize(job);
	};
}
