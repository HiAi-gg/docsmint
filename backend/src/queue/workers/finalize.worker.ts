import { finalizeJobSchema, type PipelineJob } from "../contracts";
import { deriveFinalStatus, type FinalRunStatus } from "../stage-policies";
import type { GraphPipelineState, PipelineStageStatus } from "./graph.worker";

export type { FinalRunStatus } from "../stage-policies";

export interface FinalizeWorkerDependencies {
	getRun(job: ReturnType<typeof finalizeJobSchema.parse>): Promise<
		| (GraphPipelineState & {
				status: PipelineStageStatus;
				graphStatus: PipelineStageStatus;
				summarizeStatus: PipelineStageStatus;
		  })
		| null
	>;
	setRunStatus(
		generationId: string,
		status: FinalRunStatus,
		errorCode?: string,
	): Promise<void>;
}

export function createFinalizeWorker(deps: FinalizeWorkerDependencies) {
	return async function processFinalizeJob(input: PipelineJob): Promise<void> {
		const job = finalizeJobSchema.parse(input);
		const run = await deps.getRun(job);
		if (!run) throw new Error("Pipeline run not found");
		if (run.ownerId !== job.ownerId || run.documentId !== job.documentId) {
			throw new Error("Pipeline owner mismatch");
		}
		if (
			run.generationId !== job.generationId ||
			run.revision !== job.revision
		) {
			await deps.setRunStatus(job.generationId, "cancelled", "stale_revision");
			return;
		}
		await deps.setRunStatus(job.generationId, deriveFinalStatus(run));
	};
}

export { deriveFinalStatus };
