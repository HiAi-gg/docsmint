import type { JobsOptions } from "bullmq";
import type { PipelineSource, PipelineStage } from "./contracts";

export const QUEUE_NAMES = {
	prepare: "hiai-docs-prepare-v1",
	embed: "hiai-docs-embed-v1",
	graph: "hiai-docs-graph-v1",
	summarize: "hiai-docs-summarize-v1",
	finalize: "hiai-docs-finalize-v1",
} as const satisfies Record<PipelineStage, string>;

export const SOURCE_PRIORITY = {
	interactive: 1,
	import: 2,
	api: 2,
	reindex: 10,
	backfill: 20,
} as const satisfies Record<PipelineSource, number>;

export const DEFAULT_JOB_OPTIONS: JobsOptions & {
	attempts: number;
	backoff: { type: "exponential"; delay: number };
	removeOnComplete: { count: number };
	removeOnFail: { count: number };
} = {
	attempts: 5,
	backoff: { type: "exponential", delay: 1_000 },
	removeOnComplete: { count: 1_000 },
	removeOnFail: { count: 5_000 },
};

export function configureDefaultJobOptions(input: {
	attempts: number;
	retryBaseDelayMs: number;
	completedRetentionCount: number;
	failedRetentionCount: number;
}): void {
	DEFAULT_JOB_OPTIONS.attempts = input.attempts;
	DEFAULT_JOB_OPTIONS.backoff.delay = input.retryBaseDelayMs;
	DEFAULT_JOB_OPTIONS.removeOnComplete.count = input.completedRetentionCount;
	DEFAULT_JOB_OPTIONS.removeOnFail.count = input.failedRetentionCount;
}
