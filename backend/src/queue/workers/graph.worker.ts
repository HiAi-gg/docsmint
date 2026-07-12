import { graphJobSchema, type PipelineJob } from "../contracts";

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
	embedStatus: PipelineStageStatus;
}

export interface GraphWorkerDependencies {
	getRun(
		job: ReturnType<typeof graphJobSchema.parse>,
	): Promise<GraphPipelineState | null>;
	extract(job: ReturnType<typeof graphJobSchema.parse>): Promise<void>;
	setGraphStatus(
		generationId: string,
		status: PipelineStageStatus,
		errorCode?: string,
	): Promise<void>;
	enqueueSummarize(job: ReturnType<typeof graphJobSchema.parse>): Promise<void>;
}

/**
 * Graph is deliberately isolated from embedding activation. A graph failure
 * changes only graphStatus; the active embedding generation remains ready.
 */
export function createGraphWorker(deps: GraphWorkerDependencies) {
	return async function processGraphJob(input: PipelineJob): Promise<void> {
		const job = graphJobSchema.parse(input);
		const run = await deps.getRun(job);
		if (!run) throw new Error("Pipeline run not found");
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
			return;
		}
		if (run.embedStatus !== "ready") {
			await deps.setGraphStatus(
				job.generationId,
				"skipped",
				"embedding_not_ready",
			);
			await deps.enqueueSummarize(job);
			return;
		}

		await deps.setGraphStatus(job.generationId, "processing");
		try {
			await deps.extract(job);
			await deps.setGraphStatus(job.generationId, "ready");
			await deps.enqueueSummarize(job);
		} catch (error) {
			await deps.setGraphStatus(
				job.generationId,
				"failed",
				error instanceof Error ? error.name : "graph_failed",
			);
			// GraphRAG is optional. Always advance the pipeline after an
			// extraction failure so embeddings remain usable and finalize can
			// publish ready_with_warnings. The deterministic summarize job id
			// makes retries idempotent in BullMQ.
			await deps.enqueueSummarize(job);
			throw error;
		}
	};
}
