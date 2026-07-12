import { describe, expect, test } from "bun:test";
import type { PipelineRunStore } from "../queue/enqueue";
import {
	classifyPipelineError,
	type RecoverablePipelineJob,
	recoverStalledPipeline,
} from "../queue/recovery";

// @ts-expect-error Bun supports query-suffixed TypeScript module imports.
const { enqueueDocumentPipeline } = await import("../queue/enqueue.ts?r");

const candidate: RecoverablePipelineJob = {
	runId: "run-1",
	stage: "graph",
	attempts: 1,
	observedUpdatedAt: new Date(900_000),
	job: {
		schemaVersion: 1,
		stage: "graph",
		documentId: "11111111-1111-4111-8111-111111111111",
		ownerId: "22222222-2222-4222-8222-222222222222",
		generationId: "33333333-3333-4333-8333-333333333333",
		revision: "rev-1",
		requestedAt: new Date().toISOString(),
		source: "import",
	},
};

const pendingPrepareCandidate: RecoverablePipelineJob = {
	runId: "run-pending",
	stage: "prepare",
	attempts: 0,
	observedUpdatedAt: new Date(700_000),
	job: {
		schemaVersion: 1,
		stage: "prepare",
		documentId: "44444444-4444-4444-8444-444444444444",
		ownerId: "55555555-5555-4555-8555-555555555555",
		generationId: "66666666-6666-4666-8666-666666666666",
		revision: "committed-before-redis-loss",
		requestedAt: new Date(600_000).toISOString(),
		source: "import",
	},
};

describe("pipeline recovery", () => {
	test("classifies transient provider and infrastructure failures", () => {
		expect(classifyPipelineError({ status: 429, code: "rate_limit" })).toEqual({
			code: "rate_limit",
			retryable: true,
		});
		expect(classifyPipelineError(new Error("invalid payload"))).toEqual({
			code: "Error",
			retryable: false,
		});
		expect(
			classifyPipelineError({ code: "provider_circuit_open" }).retryable,
		).toBe(true);
	});

	test("claims and requeues stalled jobs with deterministic ids", async () => {
		const queued: Array<Record<string, unknown>> = [];
		const result = await recoverStalledPipeline(
			{
				findStalled: async () => [candidate],
				claimRetry: async () => true,
				markExhausted: async () => undefined,
			},
			{ add: async (_stage, _name, _job, options) => queued.push(options) },
			{ now: new Date(1_000_000) },
		);
		expect(result).toEqual({ recovered: 1, exhausted: 0 });
		expect(queued[0]?.jobId).toBe(`graph-${candidate.job.generationId}`);
	});

	test("marks exhausted runs without requeueing", async () => {
		let exhausted = "";
		const result = await recoverStalledPipeline(
			{
				findStalled: async () => [{ ...candidate, attempts: 5 }],
				claimRetry: async () => true,
				markExhausted: async ({ errorCode }) => {
					exhausted = errorCode;
				},
			},
			{
				add: async () => {
					throw new Error("must not enqueue");
				},
			},
		);
		expect(result).toEqual({ recovered: 0, exhausted: 1 });
		expect(exhausted).toBe("recovery_attempts_exhausted");
	});

	test("recovers a durable pending run exactly once after Queue.add failure", async () => {
		let committed: Parameters<PipelineRunStore["findOrCreate"]>[0] | undefined;
		const runs: PipelineRunStore = {
			async findOrCreate(input) {
				committed = input;
				return { run: { generationId: input.generationId }, created: true };
			},
		};
		await expect(
			enqueueDocumentPipeline(
				{
					documentId: pendingPrepareCandidate.job.documentId,
					ownerId: pendingPrepareCandidate.job.ownerId,
					revision: pendingPrepareCandidate.job.revision,
					source: "import",
					requestedAt: pendingPrepareCandidate.job.requestedAt,
				},
				{
					runs,
					prepareQueue: {
						add: async () => {
							throw new Error("redis unavailable after DB commit");
						},
					},
				},
			),
		).rejects.toThrow("redis unavailable after DB commit");
		expect(committed).toBeDefined();
		if (!committed) throw new Error("test run was not committed");
		const recoverable = {
			...pendingPrepareCandidate,
			job: {
				...pendingPrepareCandidate.job,
				generationId: committed.generationId,
			},
		};
		const queued: Array<{
			jobId: unknown;
			job: RecoverablePipelineJob["job"];
		}> = [];
		let claimed = false;
		const store = {
			findStalled: async () => [recoverable],
			claimRetry: async (input: { observedUpdatedAt: Date }) => {
				expect(input.observedUpdatedAt).toEqual(recoverable.observedUpdatedAt);
				if (claimed) return false;
				claimed = true;
				return true;
			},
			markExhausted: async () => undefined,
		};
		const queues = {
			add: async (
				_stage: string,
				_name: string,
				job: RecoverablePipelineJob["job"],
				options: Record<string, unknown>,
			) => queued.push({ jobId: options.jobId, job }),
		};

		const first = await recoverStalledPipeline(store, queues, {
			now: new Date(1_000_000),
		});
		const concurrentRestart = await recoverStalledPipeline(store, queues, {
			now: new Date(1_000_000),
		});

		expect(first).toEqual({ recovered: 1, exhausted: 0 });
		expect(concurrentRestart).toEqual({ recovered: 0, exhausted: 0 });
		expect(queued).toHaveLength(1);
		expect(queued[0]?.job).toEqual(recoverable.job);
		expect(queued[0]?.jobId).toBe(
			`prepare-${recoverable.job.documentId}-${recoverable.job.generationId}`,
		);
	});
});
