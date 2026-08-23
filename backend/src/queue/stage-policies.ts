import { isStaleRevisionError } from "../lib/graph/generation-state";

export type PipelineStageStatus =
	| "pending"
	| "processing"
	| "ready"
	| "retrying"
	| "failed"
	| "skipped"
	| "cancelled";

export type FinalRunStatus =
	| "ready"
	| "ready_with_warnings"
	| "failed"
	| "cancelled";

export interface PipelineJobIdentity {
	ownerId: string;
	documentId: string;
	generationId: string;
	revision: string;
	embeddingContextHash?: string;
}

export interface PipelineRunState extends PipelineJobIdentity {
	status: PipelineStageStatus;
	embedStatus: PipelineStageStatus;
	graphStatus: PipelineStageStatus;
	summarizeStatus: PipelineStageStatus;
}

export function deriveFinalStatus(run: PipelineRunState): FinalRunStatus {
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

export interface SummaryStageDependencies<TJob extends PipelineJobIdentity> {
	isCancelled?(job: TJob): Promise<boolean>;
	isCurrent?(job: TJob): Promise<boolean>;
	getRun(
		job: TJob,
	): Promise<Pick<
		PipelineRunState,
		| "ownerId"
		| "documentId"
		| "generationId"
		| "revision"
		| "embedStatus"
		| "embeddingContextHash"
	> | null>;
	enabled(): boolean;
	summarize(job: TJob): Promise<"ready" | "skipped" | "cancelled">;
	setSummaryStatus(
		generationId: string,
		status: PipelineStageStatus,
		errorCode?: string,
	): Promise<void>;
	enqueueFinalize(job: TJob): Promise<void>;
	cancelStaleRun?(
		job: TJob,
		errorCode?: "stale_revision" | "stale_context",
	): Promise<void>;
}

/** Optional summary failures are terminal so BullMQ cannot race finalization. */
export async function processSummaryStage<TJob extends PipelineJobIdentity>(
	job: TJob,
	dependencies: SummaryStageDependencies<TJob>,
): Promise<void> {
	const isExplicitlyCancelled = async () =>
		(await dependencies.isCancelled?.(job)) === true;
	const hasCurrentGeneration = async () =>
		(await dependencies.isCurrent?.(job)) !== false;
	const continueIfCurrent = async () => {
		if (await isExplicitlyCancelled()) return false;
		if (await hasCurrentGeneration()) return true;
		await dependencies.cancelStaleRun?.(job);
		return false;
	};
	if (!(await continueIfCurrent())) return;
	const run = await dependencies.getRun(job);
	if (!run) throw new Error("Pipeline run not found");
	if (run.ownerId !== job.ownerId || run.documentId !== job.documentId) {
		throw new Error("Pipeline owner mismatch");
	}
	if (run.generationId !== job.generationId || run.revision !== job.revision) {
		await dependencies.setSummaryStatus(
			job.generationId,
			"cancelled",
			"stale_revision",
		);
		await dependencies.cancelStaleRun?.(job, "stale_revision");
		return;
	}
	if (
		job.embeddingContextHash !== undefined &&
		run.embeddingContextHash !== job.embeddingContextHash
	) {
		await dependencies.setSummaryStatus(
			job.generationId,
			"cancelled",
			"stale_context",
		);
		await dependencies.cancelStaleRun?.(job, "stale_context");
		return;
	}
	if (!dependencies.enabled()) {
		if (!(await continueIfCurrent())) return;
		await dependencies.setSummaryStatus(job.generationId, "skipped");
		if (!(await continueIfCurrent())) return;
		await dependencies.enqueueFinalize(job);
		return;
	}
	if (!(await continueIfCurrent())) return;
	await dependencies.setSummaryStatus(job.generationId, "processing");
	try {
		if (!(await continueIfCurrent())) return;
		const status = await dependencies.summarize(job);
		if (status === "cancelled") {
			if (await isExplicitlyCancelled()) {
				await dependencies.setSummaryStatus(job.generationId, "cancelled");
				return;
			}
			await dependencies.setSummaryStatus(
				job.generationId,
				"cancelled",
				"stale_revision",
			);
			await dependencies.cancelStaleRun?.(job);
			return;
		}
		if (await isExplicitlyCancelled()) {
			await dependencies.setSummaryStatus(job.generationId, "cancelled");
			return;
		}
		if (!(await hasCurrentGeneration())) {
			if (await isExplicitlyCancelled()) return;
			await dependencies.setSummaryStatus(
				job.generationId,
				"cancelled",
				"stale_revision",
			);
			await dependencies.cancelStaleRun?.(job);
			return;
		}
		await dependencies.setSummaryStatus(job.generationId, status);
	} catch (error) {
		if (!(await continueIfCurrent())) return;
		await dependencies.setSummaryStatus(
			job.generationId,
			"failed",
			error instanceof Error ? error.name : "summary_failed",
		);
		if (!(await continueIfCurrent())) return;
		await dependencies.enqueueFinalize(job);
		return;
	}
	if (!(await continueIfCurrent())) return;
	await dependencies.enqueueFinalize(job);
}

export interface GraphStageFailureDependencies<
	TJob extends PipelineJobIdentity,
> {
	isCancelled?(job: TJob): Promise<boolean>;
	setGraphStatus(
		generationId: string,
		status: PipelineStageStatus,
		errorCode?: string,
	): Promise<void>;
	cancelStaleRun(job: TJob): Promise<void>;
	enqueueSummarize(job: TJob): Promise<void>;
}

export async function processGraphStageFailure<
	TJob extends PipelineJobIdentity,
>(
	job: TJob,
	error: unknown,
	dependencies: GraphStageFailureDependencies<TJob>,
): Promise<void> {
	if (isStaleRevisionError(error)) {
		await dependencies.setGraphStatus(
			job.generationId,
			"cancelled",
			"stale_revision",
		);
		await dependencies.cancelStaleRun(job);
		return;
	}
	if (await dependencies.isCancelled?.(job)) throw error;
	await dependencies.setGraphStatus(
		job.generationId,
		"failed",
		error instanceof Error ? error.name : "graph_failed",
	);
	if (!(await dependencies.isCancelled?.(job))) {
		await dependencies.enqueueSummarize(job);
	}
	throw error;
}
