import { type PipelineJob, summarizeJobSchema } from "../contracts";
import {
	processSummaryStage,
	type SummaryStageDependencies,
} from "../stage-policies";

type SummarizeJob = ReturnType<typeof summarizeJobSchema.parse>;

export interface SummarizeWorkerDependencies
	extends SummaryStageDependencies<SummarizeJob> {}

/** Summary is optional and never controls embedding or GraphRAG readiness. */
export function createSummarizeWorker(deps: SummarizeWorkerDependencies) {
	return async function processSummarizeJob(input: PipelineJob): Promise<void> {
		const job = summarizeJobSchema.parse(input);
		await processSummaryStage(job, deps);
	};
}
