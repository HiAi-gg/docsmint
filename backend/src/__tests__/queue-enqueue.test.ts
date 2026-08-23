import { describe, expect, test } from "bun:test";
import type {
	EnqueueDependencies,
	PipelineRunStore,
	PrepareQueueWriter,
} from "../queue/enqueue";

// Bun's integration harness mocks the production route import globally. A
// query-suffixed module identity keeps this unit under test real regardless of
// file scheduling/order in the combined suite.
// @ts-expect-error Bun supports query-suffixed TypeScript module imports.
const { enqueueDocumentPipeline } = await import("../queue/enqueue.ts?unit");

const documentId = "11111111-1111-4111-8111-111111111111";
const ownerA = "22222222-2222-4222-8222-222222222222";
const ownerB = "33333333-3333-4333-8333-333333333333";

function harness(): {
	deps: EnqueueDependencies;
	jobs: Array<{
		data: { ownerId: string; refreshMode?: "incremental" | "full" };
		jobId: string;
	}>;
} {
	const active = new Map<string, string>();
	const runs: PipelineRunStore = {
		async isCancelled() {
			return false;
		},
		async findOrCreate(input) {
			const key = `${input.ownerId}:${input.documentId}:${input.revision}`;
			const existing = active.get(key);
			if (existing && !input.forceNewGeneration)
				return { run: { generationId: existing }, created: false };
			active.set(key, input.generationId);
			return { run: { generationId: input.generationId }, created: true };
		},
	};
	const jobs: Array<{
		data: { ownerId: string; refreshMode?: "incremental" | "full" };
		jobId: string;
	}> = [];
	const prepareQueue: PrepareQueueWriter = {
		async add(_name, data, options) {
			jobs.push({ data, jobId: options.jobId });
			return {
				async remove() {
					jobs.pop();
				},
			};
		},
	};
	return { deps: { runs, prepareQueue }, jobs };
}

describe("document pipeline enqueue", () => {
	test("deduplicates the same owner, document, and revision", async () => {
		const { deps, jobs } = harness();
		const input = {
			documentId,
			ownerId: ownerA,
			revision: "revision-1",
			source: "interactive" as const,
		};
		const first = await enqueueDocumentPipeline(input, deps);
		const second = await enqueueDocumentPipeline(input, deps);
		expect(second).toEqual({
			generationId: first.generationId,
			deduplicated: true,
		});
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.jobId).toBe(`prepare-${documentId}-${first.generationId}`);
		expect(jobs[0]?.data.refreshMode).toBe("incremental");
	});

	test("carries full refresh mode into a forced replacement prepare job", async () => {
		const { deps, jobs } = harness();
		const input = {
			documentId,
			ownerId: ownerA,
			revision: "same-revision",
			source: "interactive" as const,
		};
		await enqueueDocumentPipeline(input, deps);
		await enqueueDocumentPipeline(
			{
				...input,
				forceNewGeneration: true,
				refreshMode: "full",
			},
			deps,
		);

		expect(jobs.map((job) => job.data.refreshMode)).toEqual([
			"incremental",
			"full",
		]);
	});

	test("never shares runs or jobs across owners", async () => {
		const { deps, jobs } = harness();
		const common = {
			documentId,
			revision: "revision-1",
			source: "api" as const,
		};
		const first = await enqueueDocumentPipeline(
			{ ...common, ownerId: ownerA },
			deps,
		);
		const second = await enqueueDocumentPipeline(
			{ ...common, ownerId: ownerB },
			deps,
		);
		expect(first.generationId).not.toBe(second.generationId);
		expect(jobs.map((job) => job.data.ownerId)).toEqual([ownerA, ownerB]);
		expect(new Set(jobs.map((job) => job.jobId)).size).toBe(2);
	});

	test("forceNewGeneration supersedes an active run for explicit reindex recovery", async () => {
		const { deps, jobs } = harness();
		const input = {
			documentId,
			ownerId: ownerA,
			revision: "revision-1",
			source: "reindex" as const,
		};
		const first = await enqueueDocumentPipeline(input, deps);
		const replacement = await enqueueDocumentPipeline(
			{ ...input, forceNewGeneration: true },
			deps,
		);

		expect(replacement.deduplicated).toBe(false);
		expect(replacement.generationId).not.toBe(first.generationId);
		expect(jobs).toHaveLength(2);
	});

	test("leaves a created run recoverable when BullMQ enqueue fails", async () => {
		const { deps } = harness();
		deps.prepareQueue.add = async () => {
			throw new Error("redis unavailable");
		};
		await expect(
			enqueueDocumentPipeline(
				{
					documentId,
					ownerId: ownerA,
					revision: "revision-2",
					source: "import",
				},
				deps,
			),
		).rejects.toThrow("redis unavailable");
	});

	test("removes prepare job when cancellation wins after add", async () => {
		const { deps, jobs } = harness();
		deps.runs.isCancelled = async () => true;
		await enqueueDocumentPipeline(
			{ documentId, ownerId: ownerA, revision: "race", source: "api" },
			deps,
		);
		expect(jobs).toHaveLength(0);
	});

	test("propagates unexpected prepare removal failures", async () => {
		const { deps } = harness();
		deps.runs.isCancelled = async () => true;
		deps.prepareQueue.add = async () => ({
			remove: async () => {
				throw new Error("redis unavailable");
			},
		});
		await expect(
			enqueueDocumentPipeline(
				{ documentId, ownerId: ownerA, revision: "race-error", source: "api" },
				deps,
			),
		).rejects.toThrow("redis unavailable");
	});
});
