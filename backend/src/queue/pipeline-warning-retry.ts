import { isRetryablePipelineError } from "../lib/pipeline-error";
import { JOB_IDS } from "./contracts";
export interface WarningStageState {
	graphStatus: string;
	summarizeStatus: string;
	graphErrorCode: string | null;
	summarizeErrorCode: string | null;
}

export function resolveActiveWarningRetry(
	stageStarted: boolean,
	retryJobExists: boolean,
): "enqueue" | "deduplicate" | "conflict" {
	if (!stageStarted) return "enqueue";
	return retryJobExists ? "deduplicate" : "conflict";
}

export function warningRetryJobId(
	stage: "graph" | "summarize",
	generationId: string,
): string {
	return `${stage}-warning-retry-${generationId}`;
}

export function summaryJobIdForPipeline(job: {
	generationId: string;
	workspaceId?: string;
	warningRetry?: true;
}): string {
	return job.warningRetry
		? warningRetryJobId("summarize", job.generationId)
		: JOB_IDS.summarize(job.generationId, job.workspaceId);
}

export function planWarningStageRetry(state: WarningStageState): {
	graph: boolean;
	summarize: boolean;
	entryStage: "graph" | "summarize";
} | null {
	const graph =
		state.graphStatus === "failed" &&
		isRetryablePipelineError(state.graphErrorCode ?? "graph_failed");
	const summarize =
		state.summarizeStatus === "failed" &&
		isRetryablePipelineError(state.summarizeErrorCode ?? "summary_failed");
	if (!graph && !summarize) return null;
	return { graph, summarize, entryStage: graph ? "graph" : "summarize" };
}
