import { type Job, Worker } from "bullmq";
import { chunkText } from "../../embedding/chunker";
import { createBullMqConnection } from "../connection";
import {
	DEFAULT_EMBED_CHUNKS_PER_JOB,
	type EmbedBatchJob,
	JOB_IDS,
	type PipelineJob,
	type PrepareJob,
	prepareJobSchema,
} from "../contracts";
import { withOwnerSlot } from "../fair-scheduler";
import { DEFAULT_JOB_OPTIONS, QUEUE_NAMES, SOURCE_PRIORITY } from "../names";

export interface PrepareWorkerDependencies {
	loadDocument(input: {
		documentId: string;
		ownerId: string;
	}): Promise<{ title: string; content: string; revision: string } | null>;
	prepareRun(input: {
		job: PrepareJob;
		totalChunks: number;
		batches: Array<{
			batchIndex: number;
			chunkStart: number;
			chunkEnd: number;
		}>;
	}): Promise<"prepared" | "duplicate" | "stale">;
	/**
	 * Finalize a generation that has no chunks. Empty documents still need to
	 * leave the durable pipeline state, rather than waiting forever in embed.
	 */
	completeEmpty(job: PrepareJob): Promise<void>;
	markStale(job: PrepareJob, errorCode: string): Promise<void>;
	claimPendingBatches(job: PrepareJob, limit: number): Promise<EmbedBatchJob[]>;
	enqueueEmbed(
		data: EmbedBatchJob,
		options: typeof DEFAULT_JOB_OPTIONS & { jobId: string; priority: number },
	): Promise<unknown>;
	enqueueGraph(
		data: PipelineJob,
		options: typeof DEFAULT_JOB_OPTIONS & { jobId: string; priority: number },
	): Promise<unknown>;
}

export async function processPrepareJob(
	rawJob: Pick<Job<PrepareJob>, "data">,
	deps: PrepareWorkerDependencies,
	batchSize = DEFAULT_EMBED_CHUNKS_PER_JOB,
	maxActiveBatches = 2,
): Promise<{ status: "prepared" | "duplicate" | "stale"; batches: number }> {
	const job = prepareJobSchema.parse(rawJob.data);
	const document = await deps.loadDocument(job);
	if (!document || document.revision !== job.revision) {
		await deps.markStale(job, "stale_revision");
		return { status: "stale", batches: 0 };
	}
	const chunks = chunkText(`${document.title}\n\n${document.content}`);
	const batches = Array.from(
		{ length: Math.ceil(chunks.length / batchSize) },
		(_, batchIndex) => ({
			batchIndex,
			chunkStart: batchIndex * batchSize,
			chunkEnd: Math.min(chunks.length, (batchIndex + 1) * batchSize),
		}),
	);
	const state = await deps.prepareRun({
		job,
		totalChunks: chunks.length,
		batches,
	});
	if (state !== "prepared") {
		if (state === "stale") await deps.markStale(job, "stale_prepare");
		return { status: state, batches: batches.length };
	}
	if (batches.length === 0) {
		await deps.completeEmpty(job);
		await deps.enqueueGraph(
			{ ...job, stage: "graph" },
			{
				...DEFAULT_JOB_OPTIONS,
				jobId: JOB_IDS.graph(job.generationId),
				priority: SOURCE_PRIORITY[job.source],
			},
		);
		return { status: "prepared", batches: 0 };
	}
	const initial = await deps.claimPendingBatches(job, maxActiveBatches);
	await Promise.all(
		initial.map((data) =>
			deps.enqueueEmbed(data, {
				...DEFAULT_JOB_OPTIONS,
				jobId: JOB_IDS.embed(job.generationId, data.batchIndex),
				priority: SOURCE_PRIORITY[job.source],
			}),
		),
	);
	return { status: "prepared", batches: batches.length };
}

export function createPrepareWorker(
	redisUrl: string,
	deps: PrepareWorkerDependencies,
	options: {
		concurrency?: number;
		batchSize?: number;
		maxActiveBatches?: number;
	} = {},
): Worker<PrepareJob> {
	return new Worker<PrepareJob>(
		QUEUE_NAMES.prepare,
		(job) =>
			withOwnerSlot(job.data.ownerId, "prepare", () =>
				processPrepareJob(
					job,
					deps,
					options.batchSize,
					options.maxActiveBatches,
				),
			),
		{
			connection: createBullMqConnection(redisUrl),
			concurrency: options.concurrency ?? 2,
		},
	);
}
