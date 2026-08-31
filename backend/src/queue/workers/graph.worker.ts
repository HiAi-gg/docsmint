import { PipelineProviderError } from "../../lib/pipeline-error";
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
	summarizeStatus?: PipelineStageStatus;
}

export type GraphStageOutcome =
	| { status: "ready" }
	| { status: "unavailable" | "failed" | "stale"; warning: string };

export interface GraphWorkerDependencies {
	isCancelled?(job: ReturnType<typeof graphJobSchema.parse>): Promise<boolean>;
	getRun(
		job: ReturnType<typeof graphJobSchema.parse>,
	): Promise<GraphPipelineState | null>;
	extract(
		job: ReturnType<typeof graphJobSchema.parse>,
	): Promise<GraphStageOutcome>;
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
	enqueueFinalize?(job: ReturnType<typeof graphJobSchema.parse>): Promise<void>;
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
		const continuePipeline = async () => {
			if (await deps.isCancelled?.(job)) return;
			if (
				run.summarizeStatus === "ready" ||
				run.summarizeStatus === "skipped"
			) {
				if (deps.enqueueFinalize) await deps.enqueueFinalize(job);
				else await deps.enqueueSummarize(job);
				return;
			}
			await deps.enqueueSummarize(job);
		};
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
			await continuePipeline();
			return;
		}

		if (await deps.isCancelled?.(job)) return;
		await deps.setGraphStatus(job.generationId, "processing");
		try {
			if (await deps.isCancelled?.(job)) return;
			const outcome = await deps.extract(job);
			if (await deps.isCancelled?.(job)) {
				await deps.compensateExtract?.(job);
				return;
			}
			if (outcome.status === "stale") {
				await deps.setGraphStatus(
					job.generationId,
					"cancelled",
					outcome.warning,
				);
				await deps.cancelStaleRun(job, "stale_revision");
				return;
			}
			if (outcome.status === "unavailable" || outcome.status === "failed") {
				if (
					outcome.status === "failed" &&
					[
						"provider_failure",
						"provider_timeout",
						"invalid_provider_response",
					].includes(outcome.warning)
				) {
					throw new PipelineProviderError(
						outcome.warning as
							| "provider_failure"
							| "provider_timeout"
							| "invalid_provider_response",
						true,
					);
				}
				await deps.setGraphStatus(job.generationId, "failed", outcome.warning);
				await continuePipeline();
				return;
			}
			await deps.setGraphStatus(job.generationId, "ready");
			await continuePipeline();
		} catch (error) {
			await processGraphStageFailure(job, error, deps);
		}
	};
}
