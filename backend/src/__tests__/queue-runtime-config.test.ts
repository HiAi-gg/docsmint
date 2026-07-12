import { describe, expect, test } from "bun:test";
import type { EmbedBatchJob, PrepareJob } from "../queue/contracts";
import { processPrepareJob } from "../queue/workers/prepare.worker";

describe("queue runtime configuration", () => {
	test("honors the configured embedding batch size", async () => {
		const jobs: EmbedBatchJob[] = [];
		let prepared: Array<{
			batchIndex: number;
			chunkStart: number;
			chunkEnd: number;
		}> = [];
		const job: PrepareJob = {
			schemaVersion: 1,
			stage: "prepare",
			documentId: "11111111-1111-4111-8111-111111111111",
			ownerId: "22222222-2222-4222-8222-222222222222",
			generationId: "33333333-3333-4333-8333-333333333333",
			revision: "revision-1",
			requestedAt: new Date().toISOString(),
			source: "import",
		};
		const result = await processPrepareJob(
			{ data: job },
			{
				loadDocument: async () => ({
					title: "Configured batches",
					content: Array.from(
						{ length: 50 },
						(_, index) => `${index} ${"word ".repeat(150)}`,
					).join("\n\n"),
					revision: job.revision,
				}),
				prepareRun: async ({ batches }) => {
					prepared = batches;
					return "prepared";
				},
				completeEmpty: async () => undefined,
				markStale: async () => undefined,
				claimPendingBatches: async (_job, limit) =>
					prepared.slice(0, limit).map((batch) => ({
						...job,
						stage: "embed",
						batchIndex: batch.batchIndex,
						totalBatches: prepared.length,
						chunkIndexes: Array.from(
							{ length: batch.chunkEnd - batch.chunkStart },
							(_, offset) => batch.chunkStart + offset,
						),
					})),
				enqueueEmbed: async (data) => jobs.push(data),
				enqueueGraph: async () => undefined,
			},
			2,
			2,
		);
		expect(result.batches).toBeGreaterThan(1);
		expect(jobs.every((queued) => queued.chunkIndexes.length <= 2)).toBe(true);
		expect(jobs).toHaveLength(2);
	});
});
