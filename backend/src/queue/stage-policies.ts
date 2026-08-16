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
		"ownerId" | "documentId" | "generationId" | "revision" | "embedStatus"
	> | null>;
	enabled(): boolean;
	summarize(job: TJob): Promise<"ready" | "skipped" | "cancelled">;
	setSummaryStatus(
		generationId: string,
		status: PipelineStageStatus,
		errorCode?: string,
	): Promise<void>;
	enqueueFinalize(job: TJob): Promise<void>;
}

/** Optional summary failures are terminal so BullMQ cannot race finalization. */
export async function processSummaryStage<TJob extends PipelineJobIdentity>(
	job: TJob,
	dependencies: SummaryStageDependencies<TJob>,
): Promise<void> {
	const isCurrent = async () =>
		!(await dependencies.isCancelled?.(job)) &&
		(await dependencies.isCurrent?.(job)) !== false;
	if (!(await isCurrent())) return;
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
		return;
	}
	if (!dependencies.enabled()) {
		if (!(await isCurrent())) return;
		await dependencies.setSummaryStatus(job.generationId, "skipped");
		if (await isCurrent()) await dependencies.enqueueFinalize(job);
		return;
	}
	if (!(await isCurrent())) return;
	await dependencies.setSummaryStatus(job.generationId, "processing");
	try {
		if (!(await isCurrent())) return;
		const status = await dependencies.summarize(job);
		if (status === "cancelled" || !(await isCurrent())) {
			await dependencies.setSummaryStatus(
				job.generationId,
				"cancelled",
				"stale_revision",
			);
			return;
		}
		await dependencies.setSummaryStatus(job.generationId, status);
	} catch (error) {
		if (!(await isCurrent())) return;
		await dependencies.setSummaryStatus(
			job.generationId,
			"failed",
			error instanceof Error ? error.name : "summary_failed",
		);
		if (await isCurrent()) await dependencies.enqueueFinalize(job);
		return;
	}
	if (await isCurrent()) await dependencies.enqueueFinalize(job);
}
