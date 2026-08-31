import { isRetryablePipelineError } from "../lib/pipeline-error";
export interface WarningStageState {
	graphStatus: string;
	summarizeStatus: string;
	graphErrorCode: string | null;
	summarizeErrorCode: string | null;
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
