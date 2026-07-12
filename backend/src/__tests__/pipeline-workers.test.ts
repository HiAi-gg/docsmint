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
			prepareRun: async () =>
				++calls === 1 ? ("prepared" as const) : ("duplicate" as const),
			markStale: async () => undefined,
			enqueueEmbed: async (data: EmbedBatchJob) => jobs.push(data),
		};
		const first = await processPrepareJob({ data: job }, deps);
		const second = await processPrepareJob({ data: job }, deps);
		expect(first.batches).toBeGreaterThan(1);
		expect(jobs.every((queued) => queued.chunkIndexes.length <= 5)).toBe(true);
		expect(second.status).toBe("duplicate");
		expect(jobs).toHaveLength(first.batches);
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
				markStale: async (_job, errorCode) => {
					staleCode = errorCode;
				},
				enqueueEmbed: async () => undefined,
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
});
