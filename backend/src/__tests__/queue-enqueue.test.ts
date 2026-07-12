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
	jobs: Array<{ data: { ownerId: string }; jobId: string }>;
} {
	const active = new Map<string, string>();
	const runs: PipelineRunStore = {
		async findOrCreate(input) {
			const key = `${input.ownerId}:${input.documentId}:${input.revision}`;
			const existing = active.get(key);
			if (existing) return { run: { generationId: existing }, created: false };
			active.set(key, input.generationId);
			return { run: { generationId: input.generationId }, created: true };
		},
	};
	const jobs: Array<{ data: { ownerId: string }; jobId: string }> = [];
	const prepareQueue: PrepareQueueWriter = {
		async add(_name, data, options) {
			jobs.push({ data, jobId: options.jobId });
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
});
