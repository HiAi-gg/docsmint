import { describe, expect, test } from "bun:test";
import type { EmbedBatchJob, PrepareJob } from "../queue/contracts";
import {
	type EmbedWorkerDependencies,
	processEmbedJob,
} from "../queue/workers/embed.worker";
import { processPrepareJob } from "../queue/workers/prepare.worker";

const base = {
	schemaVersion: 1 as const,
	documentId: "11111111-1111-4111-8111-111111111111",
	ownerId: "22222222-2222-4222-8222-222222222222",
	generationId: "33333333-3333-4333-8333-333333333333",
	revision: "revision-1",
	requestedAt: new Date().toISOString(),
	source: "import" as const,
};

describe("prepare pipeline worker", () => {
	test("creates deterministic bounded batches and is idempotent", async () => {
		const jobs: EmbedBatchJob[] = [];
		let preparedBatches: Array<{
			batchIndex: number;
			chunkStart: number;
			chunkEnd: number;
		}> = [];
		let calls = 0;
		const job: PrepareJob = { ...base, stage: "prepare" };
		const deps = {
			loadDocument: async () => ({
				title: "Large document",
				content: Array.from(
					{ length: 18 },
					(_, i) => `${i} ${"word ".repeat(150)}`,
				).join("\n\n"),
				revision: base.revision,
			}),
			prepareRun: async ({ batches }: { batches: typeof preparedBatches }) => {
				preparedBatches = batches;
				return ++calls === 1 ? ("prepared" as const) : ("duplicate" as const);
			},
			completeEmpty: async () => undefined,
			claimPendingBatches: async (_job: PrepareJob, limit: number) =>
				preparedBatches.slice(0, limit).map((batch) => ({
					...job,
					stage: "embed" as const,
					batchIndex: batch.batchIndex,
					totalBatches: preparedBatches.length,
					chunkIndexes: Array.from(
						{ length: batch.chunkEnd - batch.chunkStart },
						(_, offset) => batch.chunkStart + offset,
					),
				})),
			markStale: async () => undefined,
			enqueueEmbed: async (data: EmbedBatchJob) => jobs.push(data),
			enqueueGraph: async () => undefined,
		};
		const first = await processPrepareJob({ data: job }, deps);
		const second = await processPrepareJob({ data: job }, deps);
		expect(first.batches).toBeGreaterThan(1);
		expect(jobs.every((queued) => queued.chunkIndexes.length <= 5)).toBe(true);
		expect(second.status).toBe("duplicate");
		expect(jobs).toHaveLength(Math.min(2, first.batches));
	});

	test("advances an empty document through a terminal downstream pipeline", async () => {
		const queuedStages: string[] = [];
		const job: PrepareJob = { ...base, stage: "prepare" };
		const result = await processPrepareJob(
			{ data: job },
			{
				loadDocument: async () => ({
					title: "",
					content: "",
					revision: base.revision,
				}),
				prepareRun: async () => "prepared",
				completeEmpty: async () => undefined,
				markStale: async () => undefined,
				claimPendingBatches: async () => [],
				enqueueEmbed: async () => {
					throw new Error("empty documents must not enqueue embed jobs");
				},
				enqueueGraph: async () => {
					queuedStages.push("graph");
				},
			},
		);
		expect(result).toEqual({ status: "prepared", batches: 0 });
		expect(queuedStages).toEqual(["graph"]);
	});

	test("rejects a superseded revision before creating batches", async () => {
		let prepared = false;
		let staleCode = "";
		const result = await processPrepareJob(
			{ data: { ...base, stage: "prepare" } },
			{
				loadDocument: async () => ({
					title: "x",
					content: "y",
					revision: "newer",
				}),
				prepareRun: async () => {
					prepared = true;
					return "prepared";
				},
				completeEmpty: async () => undefined,
				markStale: async (_job, errorCode) => {
					staleCode = errorCode;
				},
				claimPendingBatches: async () => [],
				enqueueEmbed: async () => undefined,
				enqueueGraph: async () => undefined,
			},
		);
		expect(result.status).toBe("stale");
		expect(prepared).toBe(false);
		expect(staleCode).toBe("stale_revision");
	});
});

describe("embed pipeline worker", () => {
	function harness() {
		const order: string[] = [];
		const deps: EmbedWorkerDependencies = {
			markStale: async (_job, errorCode) => {
				order.push(`stale:${errorCode}`);
			},
			loadDocument: async () => ({
				title: "Languages",
				content: "English French Portuguese",
				revision: base.revision,
				pendingGenerationId: base.generationId,
			}),
			getEmbedding: async () => ({
				ok: true,
				vector: Array.from({ length: 1024 }, (_, index) => index + 1),
				model: "model",
				provider: "primary",
				dimensions: 1024,
				profile: "model:1024:v1",
			}),
			storeBatch: async () => "stored",
			completeBatch: async () => ({ allBatchesComplete: true, totalChunks: 1 }),
			claimPendingBatches: async () => [],
			enqueueEmbed: async () => undefined,
			activateGeneration: async () => {
				order.push("activate");
			},
			enqueueGraph: async () => {
				order.push("graph");
			},
		};
		return { deps, order };
	}

	test("activates the complete embedding generation before graph enqueue", async () => {
		const { deps, order } = harness();
		const result = await processEmbedJob(
			{
				data: {
					...base,
					stage: "embed",
					batchIndex: 0,
					totalBatches: 1,
					chunkIndexes: [0],
				},
			},
			deps,
		);
		expect(result.activated).toBe(true);
		expect(order).toEqual(["activate", "graph"]);
	});

	test("fences a stale generation before provider calls", async () => {
		const { deps, order } = harness();
		let embedded = false;
		deps.loadDocument = async () => ({
			title: "x",
			content: "y",
			revision: base.revision,
			pendingGenerationId: crypto.randomUUID(),
		});
		deps.getEmbedding = async () => {
			embedded = true;
			throw new Error("must not run");
		};
		const result = await processEmbedJob(
			{
				data: {
					...base,
					stage: "embed",
					batchIndex: 0,
					totalBatches: 1,
					chunkIndexes: [0],
				},
			},
			deps,
		);
		expect(result.status).toBe("stale");
		expect(embedded).toBe(false);
		expect(order).toEqual(["stale:stale_revision"]);
	});

	test("schedules one replacement batch per completion until all are active", async () => {
		const { deps } = harness();
		const scheduled: number[] = [0, 1];
		let next = 2;
		let completed = 0;
		deps.completeBatch = async () => ({
			allBatchesComplete: ++completed === 5,
			totalChunks: 1,
		});
		deps.claimPendingBatches = async (job, limit) =>
			limit > 0 && next < 5
				? [{ ...job, batchIndex: next++, chunkIndexes: [0] }]
				: [];
		deps.enqueueEmbed = async (job) => {
			scheduled.push(job.batchIndex);
		};
		for (let batchIndex = 0; batchIndex < 5; batchIndex += 1) {
			await processEmbedJob(
				{
					data: {
						...base,
						stage: "embed",
						batchIndex,
						totalBatches: 5,
						chunkIndexes: [0],
					},
				},
				deps,
			);
		}
		expect(scheduled).toEqual([0, 1, 2, 3, 4]);
	});
});
