import { type Job, Worker } from "bullmq";
import { chunkText } from "../../embedding/chunker";
import type { EmbeddingResult } from "../../embedding/result";
import { createBullMqConnection } from "../connection";
import {
	type EmbedBatchJob,
	embedBatchJobSchema,
	JOB_IDS,
	type PipelineJob,
} from "../contracts";
import { DEFAULT_JOB_OPTIONS, QUEUE_NAMES, SOURCE_PRIORITY } from "../names";

export interface EmbedWorkerDependencies {
	loadDocument(input: {
		documentId: string;
		ownerId: string;
		generationId: string;
	}): Promise<{
		title: string;
		content: string;
		revision: string;
		pendingGenerationId: string | null;
	} | null>;
	getEmbedding(text: string): Promise<EmbeddingResult>;
	storeBatch(input: {
		job: EmbedBatchJob;
		rows: Array<{
			chunkIndex: number;
			chunkText: string;
			charStart: number;
			charEnd: number;
			embedding: number[];
			model: string;
			profile: string;
			dimensions: number;
		}>;
	}): Promise<"stored" | "duplicate" | "stale">;
	completeBatch(input: {
		job: EmbedBatchJob;
		profile: { model: string; profile: string; dimensions: number };
	}): Promise<{ allBatchesComplete: boolean; totalChunks: number }>;
	activateGeneration(input: {
		documentId: string;
		generationId: string;
		totalChunks: number;
		profile: { model: string; profile: string; dimensions: number };
	}): Promise<void>;
	enqueueGraph(
		data: PipelineJob,
		options: typeof DEFAULT_JOB_OPTIONS & { jobId: string; priority: number },
	): Promise<unknown>;
}

export async function processEmbedJob(
	rawJob: Pick<Job<EmbedBatchJob>, "data">,
	deps: EmbedWorkerDependencies,
): Promise<{ status: "stored" | "duplicate" | "stale"; activated: boolean }> {
	const job = embedBatchJobSchema.parse(rawJob.data);
	const document = await deps.loadDocument(job);
	if (
		!document ||
		document.revision !== job.revision ||
		document.pendingGenerationId !== job.generationId
	) {
		return { status: "stale", activated: false };
	}
	const chunks = chunkText(`${document.title}\n\n${document.content}`);
	const selected = job.chunkIndexes.map((index) => ({
		index,
		chunk: chunks[index],
	}));
	if (selected.some(({ chunk }) => !chunk))
		return { status: "stale", activated: false };
	const results = await Promise.all(
		selected.map(async ({ index, chunk }) => {
			if (!chunk) throw new Error("chunk_missing");
			const result = await deps.getEmbedding(chunk.text);
			if (!result.ok) throw new Error(`embedding_${result.code}`);
			return { index, chunk, result };
		}),
	);
	const first = results[0]?.result;
	if (!first) throw new Error("empty_batch");
	if (
		results.some(
			({ result }) =>
				result.model !== first.model ||
				result.profile !== first.profile ||
				result.dimensions !== first.dimensions,
		)
	)
		throw new Error("mixed_embedding_profile");
	const stored = await deps.storeBatch({
		job,
		rows: results.map(({ index, chunk, result }) => ({
			chunkIndex: index,
			chunkText: chunk.text,
			charStart: chunk.charStart,
			charEnd: chunk.charEnd,
			embedding: result.vector,
			model: result.model,
			profile: result.profile,
			dimensions: result.dimensions,
		})),
	});
	if (stored !== "stored") return { status: stored, activated: false };
	const profile = {
		model: first.model,
		profile: first.profile,
		dimensions: first.dimensions,
	};
	const completion = await deps.completeBatch({ job, profile });
	if (!completion.allBatchesComplete)
		return { status: "stored", activated: false };
	await deps.activateGeneration({
		documentId: job.documentId,
		generationId: job.generationId,
		totalChunks: completion.totalChunks,
		profile,
	});
	await deps.enqueueGraph(
		{ ...job, stage: "graph" },
		{
			...DEFAULT_JOB_OPTIONS,
			jobId: JOB_IDS.graph(job.generationId),
			priority: SOURCE_PRIORITY[job.source],
		},
	);
	return { status: "stored", activated: true };
}

export function createEmbedWorker(
	redisUrl: string,
	deps: EmbedWorkerDependencies,
): Worker<EmbedBatchJob> {
	return new Worker<EmbedBatchJob>(
		QUEUE_NAMES.embed,
		(job) => processEmbedJob(job, deps),
		{ connection: createBullMqConnection(redisUrl), concurrency: 4 },
	);
}
