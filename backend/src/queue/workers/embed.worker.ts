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
import { withOwnerSlot } from "../fair-scheduler";
import { DEFAULT_JOB_OPTIONS, QUEUE_NAMES, SOURCE_PRIORITY } from "../names";

export interface EmbedWorkerDependencies {
	isCancelled?(job: EmbedBatchJob): Promise<boolean>;
	loadDocument(input: EmbedBatchJob): Promise<{
		title: string;
		content: string;
		revision: string;
		pendingGenerationId: string | null;
		activeGenerationId?: string | null;
		embeddingContextHash?: string;
		metadataPreamble?: string;
		candidateChunkIndexes?: number[];
		batchStatus?: "processing" | "ready";
		profile?: { model: string; profile: string; dimensions: number };
	} | null>;
	getEmbedding(text: string): Promise<EmbeddingResult>;
	markStale(job: EmbedBatchJob, errorCode: string): Promise<void>;
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
	claimPendingBatches(
		job: EmbedBatchJob,
		limit: number,
	): Promise<EmbedBatchJob[]>;
	enqueueEmbed(
		data: EmbedBatchJob,
		options: typeof DEFAULT_JOB_OPTIONS & { jobId: string; priority: number },
	): Promise<unknown>;
	activateGeneration(input: {
		documentId: string;
		generationId: string;
		totalChunks: number;
		profile: { model: string; profile: string; dimensions: number };
		embeddingContextHash?: string;
	}): Promise<void>;
	enqueueGraph(
		data: PipelineJob,
		options: typeof DEFAULT_JOB_OPTIONS & { jobId: string; priority: number },
	): Promise<unknown>;
}

export async function processEmbedJob(
	rawJob: Pick<Job<EmbedBatchJob>, "data">,
	deps: EmbedWorkerDependencies,
): Promise<{
	status: "stored" | "duplicate" | "stale" | "cancelled";
	activated: boolean;
}> {
	const job = embedBatchJobSchema.parse(rawJob.data);
	if (await deps.isCancelled?.(job))
		return { status: "cancelled", activated: false };
	const document = await deps.loadDocument(job);
	if (
		!document ||
		document.revision !== job.revision ||
		(document.pendingGenerationId !== job.generationId &&
			!(
				document.batchStatus === "ready" &&
				document.activeGenerationId === job.generationId
			))
	) {
		await deps.markStale(job, "stale_revision");
		return { status: "stale", activated: false };
	}
	if (
		job.embeddingContextHash !== undefined &&
		document.embeddingContextHash !== job.embeddingContextHash
	) {
		await deps.markStale(job, "stale_context");
		return { status: "stale", activated: false };
	}
	const chunks = chunkText(`${document.title}\n\n${document.content}`);
	const candidateChunkIndexes = new Set(document.candidateChunkIndexes ?? []);
	const selected = job.chunkIndexes
		.filter((index) => !candidateChunkIndexes.has(index))
		.map((index) => ({
			index,
			chunk: chunks[index],
		}));
	if (selected.some(({ chunk }) => !chunk)) {
		await deps.markStale(job, "stale_chunks");
		return { status: "stale", activated: false };
	}
	const results =
		document.batchStatus === "ready"
			? []
			: await Promise.all(
					selected.map(async ({ index, chunk }) => {
						if (!chunk) throw new Error("chunk_missing");
						const providerText = document.metadataPreamble
							? `${document.metadataPreamble}\n\n${chunk.text}`
							: chunk.text;
						const result = await deps.getEmbedding(providerText);
						if (!result.ok) throw new Error(`embedding_${result.code}`);
						return { index, chunk, result };
					}),
				);
	const first = results[0]?.result;
	const profile = first
		? {
				model: first.model,
				profile: first.profile,
				dimensions: first.dimensions,
			}
		: document.profile;
	if (!profile) throw new Error("empty_batch");
	if (
		results.some(
			({ result }) =>
				result.model !== profile.model ||
				result.profile !== profile.profile ||
				result.dimensions !== profile.dimensions,
		)
	)
		throw new Error("mixed_embedding_profile");
	if (await deps.isCancelled?.(job))
		return { status: "cancelled", activated: false };
	const stored =
		document.batchStatus === "ready"
			? ("duplicate" as const)
			: results.length === 0
				? ("stored" as const)
				: await deps.storeBatch({
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
	if (stored === "stale") {
		await deps.markStale(job, "stale_batch");
		return { status: "stale", activated: false };
	}
	if (await deps.isCancelled?.(job))
		return { status: "cancelled", activated: false };
	const completion = await deps.completeBatch({ job, profile });
	if (!completion.allBatchesComplete) {
		const next = await deps.claimPendingBatches(job, 1);
		if (await deps.isCancelled?.(job))
			return { status: "cancelled", activated: false };
		await Promise.all(
			next.map((data) =>
				deps.enqueueEmbed(data, {
					...DEFAULT_JOB_OPTIONS,
					jobId: JOB_IDS.embed(
						job.generationId,
						data.batchIndex,
						job.workspaceId,
					),
					priority: SOURCE_PRIORITY[job.source],
				}),
			),
		);
		return { status: "stored", activated: false };
	}
	if (await deps.isCancelled?.(job))
		return { status: "cancelled", activated: false };
	await deps.activateGeneration({
		documentId: job.documentId,
		generationId: job.generationId,
		totalChunks: completion.totalChunks,
		profile,
		embeddingContextHash: job.embeddingContextHash,
	});
	if (await deps.isCancelled?.(job))
		return { status: "cancelled", activated: false };
	await deps.enqueueGraph(
		{ ...job, stage: "graph" },
		{
			...DEFAULT_JOB_OPTIONS,
			jobId: JOB_IDS.graph(job.generationId, job.workspaceId),
			priority: SOURCE_PRIORITY[job.source],
		},
	);
	return { status: stored, activated: true };
}

export function createEmbedWorker(
	redisUrl: string,
	deps: EmbedWorkerDependencies,
	options: { concurrency?: number } = {},
): Worker<EmbedBatchJob> {
	return new Worker<EmbedBatchJob>(
		QUEUE_NAMES.embed,
		(job) =>
			withOwnerSlot(job.data.ownerId, "embed", () =>
				processEmbedJob(job, deps),
			),
		{
			connection: createBullMqConnection(redisUrl),
			concurrency: options.concurrency ?? 3,
		},
	);
}
