import { type Job, Worker } from "bullmq";
import { chunkText } from "../../embedding/chunker";
import { createBullMqConnection } from "../connection";
import {
	DEFAULT_EMBED_CHUNKS_PER_JOB,
	type EmbedBatchJob,
	JOB_IDS,
	PIPELINE_SCHEMA_VERSION,
	type PrepareJob,
	prepareJobSchema,
} from "../contracts";
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
	enqueueEmbed(
		data: EmbedBatchJob,
		options: typeof DEFAULT_JOB_OPTIONS & { jobId: string; priority: number },
	): Promise<unknown>;
}

export async function processPrepareJob(
	rawJob: Pick<Job<PrepareJob>, "data">,
	deps: PrepareWorkerDependencies,
): Promise<{ status: "prepared" | "duplicate" | "stale"; batches: number }> {
	const job = prepareJobSchema.parse(rawJob.data);
	const document = await deps.loadDocument(job);
	if (!document || document.revision !== job.revision) {
		return { status: "stale", batches: 0 };
	}
	const chunks = chunkText(`${document.title}\n\n${document.content}`);
	const batches = Array.from(
		{ length: Math.ceil(chunks.length / DEFAULT_EMBED_CHUNKS_PER_JOB) },
		(_, batchIndex) => ({
			batchIndex,
			chunkStart: batchIndex * DEFAULT_EMBED_CHUNKS_PER_JOB,
			chunkEnd: Math.min(
				chunks.length,
				(batchIndex + 1) * DEFAULT_EMBED_CHUNKS_PER_JOB,
			),
		}),
	);
	const state = await deps.prepareRun({
		job,
		totalChunks: chunks.length,
		batches,
	});
	if (state !== "prepared") return { status: state, batches: batches.length };
	await Promise.all(
		batches.map((batch) => {
			const data: EmbedBatchJob = {
				...job,
				schemaVersion: PIPELINE_SCHEMA_VERSION,
				stage: "embed",
				batchIndex: batch.batchIndex,
				totalBatches: batches.length,
				chunkIndexes: Array.from(
					{ length: batch.chunkEnd - batch.chunkStart },
					(_, offset) => batch.chunkStart + offset,
				),
			};
			return deps.enqueueEmbed(data, {
				...DEFAULT_JOB_OPTIONS,
				jobId: JOB_IDS.embed(job.generationId, batch.batchIndex),
				priority: SOURCE_PRIORITY[job.source],
			});
		}),
	);
	return { status: "prepared", batches: batches.length };
}

export function createPrepareWorker(
	redisUrl: string,
	deps: PrepareWorkerDependencies,
): Worker<PrepareJob> {
	return new Worker<PrepareJob>(
		QUEUE_NAMES.prepare,
		(job) => processPrepareJob(job, deps),
		{ connection: createBullMqConnection(redisUrl), concurrency: 2 },
	);
}
