import { Worker } from "bullmq";
import { createBullMqConnection } from "./connection";
import type { PipelineJob, PipelineStage } from "./contracts";
import { withOwnerSlot } from "./fair-scheduler";
import { QUEUE_NAMES } from "./names";
import { closePipelineQueues, getPipelineQueue } from "./queues";
import {
	createEmbedWorker,
	type EmbedWorkerDependencies,
} from "./workers/embed.worker";
import {
	createFinalizeWorker,
	type FinalizeWorkerDependencies,
} from "./workers/finalize.worker";
import {
	createGraphWorker,
	type GraphWorkerDependencies,
} from "./workers/graph.worker";
import {
	createPrepareWorker,
	type PrepareWorkerDependencies,
} from "./workers/prepare.worker";
import {
	createSummarizeWorker,
	type SummarizeWorkerDependencies,
} from "./workers/summarize.worker";

export interface ManagedPipelineWorker {
	waitUntilReady?(): Promise<unknown>;
	pause?(doNotWaitActive?: boolean): Promise<void>;
	close(force?: boolean): Promise<void>;
}

export interface ManagedPipelineQueue {
	pause(): Promise<void>;
	resume(): Promise<void>;
}

export type PipelineWorkerFactory = () =>
	| ManagedPipelineWorker
	| Promise<ManagedPipelineWorker>;

export interface PipelineRuntime {
	readonly workers: ReadonlyMap<PipelineStage, ManagedPipelineWorker>;
	close(): Promise<void>;
}

export interface StartPipelineWorkersOptions {
	recover(): Promise<void>;
	workerFactories: Partial<Record<PipelineStage, PipelineWorkerFactory>>;
	queues?: Partial<Record<PipelineStage, ManagedPipelineQueue>>;
	closeQueues(): Promise<void>;
	closeConnections?: () => Promise<void>;
	shutdownGraceMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

export interface PipelineStageDependencies {
	prepare: PrepareWorkerDependencies;
	embed: EmbedWorkerDependencies;
	graph: GraphWorkerDependencies;
	summarize: SummarizeWorkerDependencies;
	finalize: FinalizeWorkerDependencies;
}

export interface PipelineWorkerSettings {
	prepareConcurrency: number;
	embedConcurrency: number;
	graphConcurrency: number;
	summarizeConcurrency: number;
	finalizeConcurrency: number;
	embedBatchSize: number;
	maxActiveBatchesPerDocument: number;
}

const STAGE_ORDER: readonly PipelineStage[] = [
	"prepare",
	"embed",
	"graph",
	"summarize",
	"finalize",
];

export function createPipelineWorkerFactories(
	redisUrl: string,
	deps: PipelineStageDependencies,
	settings: PipelineWorkerSettings = {
		prepareConcurrency: 2,
		embedConcurrency: 3,
		graphConcurrency: 2,
		summarizeConcurrency: 1,
		finalizeConcurrency: 2,
		embedBatchSize: 5,
		maxActiveBatchesPerDocument: 2,
	},
): Record<PipelineStage, PipelineWorkerFactory> {
	const connection = () => createBullMqConnection(redisUrl);
	const graphProcessor = createGraphWorker(deps.graph);
	const summarizeProcessor = createSummarizeWorker(deps.summarize);
	const finalizeProcessor = createFinalizeWorker(deps.finalize);
	return {
		prepare: () =>
			createPrepareWorker(redisUrl, deps.prepare, {
				concurrency: settings.prepareConcurrency,
				batchSize: settings.embedBatchSize,
				maxActiveBatches: settings.maxActiveBatchesPerDocument,
			}),
		embed: () =>
			createEmbedWorker(redisUrl, deps.embed, {
				concurrency: settings.embedConcurrency,
			}),
		graph: () =>
			new Worker<PipelineJob>(
				QUEUE_NAMES.graph,
				(job) =>
					withOwnerSlot(job.data.ownerId, "graph", async () => {
						await graphProcessor(job.data);
					}),
				{ connection: connection(), concurrency: settings.graphConcurrency },
			),
		summarize: () =>
			new Worker<PipelineJob>(
				QUEUE_NAMES.summarize,
				(job) =>
					withOwnerSlot(job.data.ownerId, "summarize", () =>
						summarizeProcessor(job.data),
					),
				{
					connection: connection(),
					concurrency: settings.summarizeConcurrency,
				},
			),
		finalize: () =>
			new Worker<PipelineJob>(
				QUEUE_NAMES.finalize,
				(job) =>
					withOwnerSlot(job.data.ownerId, "finalize", () =>
						finalizeProcessor(job.data),
					),
				{ connection: connection(), concurrency: settings.finalizeConcurrency },
			),
	};
}

export async function startRegisteredPipelineWorkers(input: {
	redisUrl: string;
	dependencies: PipelineStageDependencies;
	recover: () => Promise<void>;
	settings?: PipelineWorkerSettings;
	shutdownGraceMs?: number;
}): Promise<PipelineRuntime> {
	const queues = {} as Record<PipelineStage, ManagedPipelineQueue>;
	for (const stage of STAGE_ORDER) {
		queues[stage] = getPipelineQueue(stage, input.redisUrl);
	}
	return startPipelineWorkers({
		recover: input.recover,
		workerFactories: createPipelineWorkerFactories(
			input.redisUrl,
			input.dependencies,
			input.settings,
		),
		queues,
		closeQueues: closePipelineQueues,
		shutdownGraceMs: input.shutdownGraceMs,
	});
}

/**
 * Starts registered stage workers only after PostgreSQL-to-BullMQ recovery.
 * Integration wiring supplies concrete worker factories in the final Task 8
 * step; keeping lifecycle orchestration dependency-injected makes shutdown
 * semantics testable without starting Redis connections at module import.
 */
export async function startPipelineWorkers(
	options: StartPipelineWorkersOptions,
): Promise<PipelineRuntime> {
	await options.recover();

	// Queue pause state is durable in Redis. A previous graceful shutdown may
	// therefore leave every queue paused across container restarts. Resume all
	// registered queues before workers start claiming jobs.
	await Promise.all(
		Object.values(options.queues ?? {}).map((queue) => queue.resume()),
	);

	const workers = new Map<PipelineStage, ManagedPipelineWorker>();
	try {
		for (const stage of STAGE_ORDER) {
			const factory = options.workerFactories[stage];
			if (!factory) continue;
			const worker = await factory();
			workers.set(stage, worker);
			await worker.waitUntilReady?.();
		}
	} catch (error) {
		await Promise.allSettled(
			[...workers.values()].map((worker) => worker.close(true)),
		);
		await options.closeQueues().catch(() => {});
		await options.closeConnections?.().catch(() => {});
		throw error;
	}

	let closePromise: Promise<void> | undefined;
	return {
		workers,
		close() {
			if (closePromise) return closePromise;
			closePromise = closeRuntime(options, workers);
			return closePromise;
		},
	};
}

async function closeRuntime(
	options: StartPipelineWorkersOptions,
	workers: ReadonlyMap<PipelineStage, ManagedPipelineWorker>,
): Promise<void> {
	const graceMs = options.shutdownGraceMs ?? 30_000;
	const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));

	// Pause producer queues first, then stop workers from claiming more jobs.
	await Promise.allSettled(
		Object.values(options.queues ?? {}).map((queue) => queue.pause()),
	);
	await Promise.allSettled(
		[...workers.values()].map((worker) => worker.pause?.(true)),
	);

	const gracefulClose = Promise.allSettled(
		[...workers.values()].map((worker) => worker.close(false)),
	).then(() => true);
	const drained = await Promise.race([
		gracefulClose,
		sleep(graceMs).then(() => false),
	]);
	if (!drained) {
		await Promise.allSettled(
			[...workers.values()].map((worker) => worker.close(true)),
		);
	}

	await options.closeQueues();
	await options.closeConnections?.();
}
