import { finalizeJobSchema, type PipelineJob } from "../contracts";
import type { GraphPipelineState, PipelineStageStatus } from "./graph.worker";

export type FinalRunStatus =
	| "ready"
	| "ready_with_warnings"
	| "failed"
	| "cancelled";

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

function deriveFinalStatus(
	run: Awaited<ReturnType<FinalizeWorkerDependencies["getRun"]>>,
): FinalRunStatus {
	if (!run) throw new Error("Pipeline run not found");
	if (run.status === "cancelled") return "cancelled";
	if (run.embedStatus === "failed" || run.embedStatus === "cancelled")
		return "failed";
	if (run.embedStatus !== "ready") return "failed";
	if (run.graphStatus === "failed" || run.summarizeStatus === "failed") {
		return "ready_with_warnings";
	}
	if (
		(run.graphStatus === "ready" || run.graphStatus === "skipped") &&
		(run.summarizeStatus === "ready" || run.summarizeStatus === "skipped")
	) {
		return "ready";
	}
	return "failed";
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
