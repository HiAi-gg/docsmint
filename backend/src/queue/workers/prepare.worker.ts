import { type Job, Worker } from "bullmq";
import { chunkText } from "../../embedding/chunker";
import {
	buildMetadataPreamble,
	type EmbeddingMetadata,
} from "../../embedding/index";
import { chunkHash } from "../../lib/chunk-hash";
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

export interface PreparedEmbeddingChunk {
	index: number;
	hash: string;
	storedChunkText: string;
	providerText: string;
	charStart: number;
	charEnd: number;
}

export function buildEmbeddingPreparation(input: {
	title: string;
	content: string;
	metadata?: EmbeddingMetadata;
	providerIdentity: string;
}): {
	contextHash: string;
	metadataPreamble: string;
	chunks: PreparedEmbeddingChunk[];
} {
	const metadata = input.metadata
		? {
				...input.metadata,
				tagNames: [...(input.metadata.tagNames ?? [])]
					.map((tag) => tag.trim())
					.filter(Boolean)
					.sort(),
			}
		: undefined;
	const metadataPreamble = buildMetadataPreamble(metadata).trimEnd();
	const contextHash = chunkHash(
		JSON.stringify({
			metadataPreamble,
			providerIdentity: input.providerIdentity,
		}),
	);
	const chunks = chunkText(`${input.title}\n\n${input.content}`).map(
		(chunk, index) => ({
			index,
			hash: chunk.hash,
			storedChunkText: chunk.text,
			providerText: metadataPreamble
				? `${metadataPreamble}\n\n${chunk.text}`
				: chunk.text,
			charStart: chunk.charStart,
			charEnd: chunk.charEnd,
		}),
	);
	return { contextHash, metadataPreamble, chunks };
}

export interface ReusableEmbeddingRow {
	chunkIndex: number;
	chunkHash: string | null;
	embedding: number[] | null;
	embeddingModel: string;
	embeddingProfile: string;
	embeddingDimensions: number;
	isValid: boolean;
}

export function planEmbeddingReuse(input: {
	refreshMode: "incremental" | "full";
	contextHash: string;
	activeContextHash: string | null;
	provider: { model: string; profile: string; dimensions: number };
	chunks: Array<
		Pick<
			PreparedEmbeddingChunk,
			"index" | "hash" | "storedChunkText" | "charStart" | "charEnd"
		>
	>;
	activeRows: ReusableEmbeddingRow[];
}): {
	refreshMode: "incremental" | "full";
	providerChunkIndexes: number[];
	reusableChunkIndexes: number[];
} {
	const allIndexes = input.chunks.map((chunk) => chunk.index);
	const activeRowsMatchProvider = input.activeRows.every(
		(row) =>
			row.isValid &&
			row.embedding !== null &&
			row.embedding.length === input.provider.dimensions &&
			row.embedding.every(Number.isFinite) &&
			row.embedding.some((value) => value !== 0) &&
			row.embeddingModel === input.provider.model &&
			row.embeddingProfile === input.provider.profile &&
			row.embeddingDimensions === input.provider.dimensions,
	);
	const forceFull =
		input.refreshMode === "full" ||
		!input.activeContextHash ||
		input.activeContextHash !== input.contextHash ||
		!activeRowsMatchProvider;
	if (forceFull) {
		return {
			refreshMode: "full",
			providerChunkIndexes: allIndexes,
			reusableChunkIndexes: [],
		};
	}

	const rowsByIndex = new Map(
		input.activeRows.map((row) => [row.chunkIndex, row]),
	);
	const changed = new Set<number>();
	for (const chunk of input.chunks) {
		if (rowsByIndex.get(chunk.index)?.chunkHash !== chunk.hash) {
			changed.add(chunk.index);
		}
	}
	const affected = new Set<number>();
	for (const index of changed) {
		affected.add(index);
		if (index > 0) affected.add(index - 1);
		if (index < input.chunks.length - 1) affected.add(index + 1);
	}
	return {
		refreshMode: "incremental",
		providerChunkIndexes: allIndexes.filter((index) => affected.has(index)),
		reusableChunkIndexes: allIndexes.filter((index) => !affected.has(index)),
	};
}

export interface PrepareWorkerDependencies {
	isCancelled?(job: PrepareJob): Promise<boolean>;
	loadDocument(input: {
		documentId: string;
		ownerId: string;
		workspaceId?: string;
	}): Promise<{
		title: string;
		content: string;
		revision: string;
		metadata?: EmbeddingMetadata;
		providerIdentity?: string;
		provider?: { model: string; profile: string; dimensions: number };
		activeContextHash?: string | null;
		activeRows?: ReusableEmbeddingRow[];
	} | null>;
	prepareRun(input: {
		job: PrepareJob;
		totalChunks: number;
		embeddingContextHash: string;
		provider: { model: string; profile: string; dimensions: number };
		chunks: PreparedEmbeddingChunk[];
		activeRows: ReusableEmbeddingRow[];
		providerChunkIndexes: number[];
		reusableChunkIndexes: number[];
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
): Promise<{
	status: "prepared" | "duplicate" | "stale" | "cancelled";
	batches: number;
}> {
	const job = prepareJobSchema.parse(rawJob.data);
	if (await deps.isCancelled?.(job)) return { status: "cancelled", batches: 0 };
	const document = await deps.loadDocument(job);
	if (!document || document.revision !== job.revision) {
		await deps.markStale(job, "stale_revision");
		return { status: "stale", batches: 0 };
	}
	const provider = document.provider ?? {
		model: "",
		profile: "legacy",
		dimensions: 1024,
	};
	const preparation = buildEmbeddingPreparation({
		title: document.title,
		content: document.content,
		metadata: document.metadata,
		providerIdentity:
			document.providerIdentity ??
			`legacy|${provider.model}|${provider.dimensions}|${provider.profile}`,
	});
	const chunks = preparation.chunks;
	const reuse = planEmbeddingReuse({
		refreshMode: job.refreshMode,
		contextHash: preparation.contextHash,
		activeContextHash: document.activeContextHash ?? null,
		provider,
		chunks,
		activeRows: document.activeRows ?? [],
	});
	const batches = Array.from(
		{ length: Math.ceil(chunks.length / batchSize) },
		(_, batchIndex) => ({
			batchIndex,
			chunkStart: batchIndex * batchSize,
			chunkEnd: Math.min(chunks.length, (batchIndex + 1) * batchSize),
		}),
	);
	if (await deps.isCancelled?.(job)) return { status: "cancelled", batches: 0 };
	const state = await deps.prepareRun({
		job: { ...job, embeddingContextHash: preparation.contextHash },
		totalChunks: chunks.length,
		embeddingContextHash: preparation.contextHash,
		provider,
		chunks,
		activeRows: document.activeRows ?? [],
		providerChunkIndexes: reuse.providerChunkIndexes,
		reusableChunkIndexes: reuse.reusableChunkIndexes,
		batches,
	});
	if (state !== "prepared") {
		if (state === "stale") await deps.markStale(job, "stale_prepare");
		return { status: state, batches: batches.length };
	}
	if (batches.length === 0) {
		if (await deps.isCancelled?.(job))
			return { status: "cancelled", batches: 0 };
		const preparedJob = {
			...job,
			embeddingContextHash: preparation.contextHash,
		};
		await deps.completeEmpty(preparedJob);
		if (await deps.isCancelled?.(job))
			return { status: "cancelled", batches: 0 };
		await deps.enqueueGraph(
			{ ...preparedJob, stage: "graph" },
			{
				...DEFAULT_JOB_OPTIONS,
				jobId: JOB_IDS.graph(job.generationId, job.workspaceId),
				priority: SOURCE_PRIORITY[job.source],
			},
		);
		return { status: "prepared", batches: 0 };
	}
	const preparedJob = { ...job, embeddingContextHash: preparation.contextHash };
	const initial = await deps.claimPendingBatches(preparedJob, maxActiveBatches);
	if (await deps.isCancelled?.(job))
		return { status: "cancelled", batches: batches.length };
	await Promise.all(
		initial.map((data) =>
			deps.enqueueEmbed(data, {
				...DEFAULT_JOB_OPTIONS,
				jobId: JOB_IDS.embed(
					job.generationId,
					data.batchIndex,
					data.workspaceId,
				),
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
