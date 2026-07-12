import type { PipelineStage } from "./contracts";

export const PIPELINE_STAGES: readonly PipelineStage[] = [
	"prepare",
	"embed",
	"graph",
	"summarize",
	"finalize",
];

export const PIPELINE_METRIC_NAMES = [
	...PIPELINE_STAGES.flatMap((stage) => [
		`pipeline_${stage}_waiting`,
		`pipeline_${stage}_active`,
		`pipeline_${stage}_delayed`,
		`pipeline_${stage}_completed_total`,
		`pipeline_${stage}_failed_total`,
		`pipeline_${stage}_retried_total`,
		`pipeline_${stage}_wait_ms`,
		`pipeline_${stage}_duration_ms`,
	]),
	"pipeline_oldest_waiting_ms",
	"pipeline_recovered_total",
	"pipeline_stale_cancelled_total",
] as const;

export type PipelineMetricName = (typeof PIPELINE_METRIC_NAMES)[number];
export type PipelineMetricSnapshot = Record<PipelineMetricName, number>;

export function emptyPipelineMetricSnapshot(): PipelineMetricSnapshot {
	return Object.fromEntries(
		PIPELINE_METRIC_NAMES.map((name) => [name, 0]),
	) as PipelineMetricSnapshot;
}

export interface PipelineHealthInput {
	redisAvailable: boolean;
	recoveryAvailable: boolean;
	oldestInteractiveWaitMs: number;
	interactiveSloMs: number;
	graphAvailable: boolean;
}

export interface PipelineHealthReport {
	status: "healthy" | "degraded" | "unhealthy";
	degraded: { graph?: string };
	reasons: string[];
}

/** Queue health is unhealthy only for execution/recovery failures or SLO breach. */
export function evaluatePipelineHealth(
	input: PipelineHealthInput,
): PipelineHealthReport {
	const reasons: string[] = [];
	if (!input.redisAvailable) reasons.push("redis_unavailable");
	if (!input.recoveryAvailable) reasons.push("recovery_unavailable");
	if (input.oldestInteractiveWaitMs > input.interactiveSloMs) {
		reasons.push("interactive_slo_breached");
	}
	const degraded = input.graphAvailable
		? {}
		: { graph: "provider_unavailable" };
	return {
		status:
			reasons.length > 0
				? "unhealthy"
				: Object.keys(degraded).length
					? "degraded"
					: "healthy",
		degraded,
		reasons,
	};
}
