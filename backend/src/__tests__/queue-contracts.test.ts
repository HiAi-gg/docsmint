import { describe, expect, test } from "bun:test";
import * as contracts from "../queue/contracts";
import {
	configureDefaultJobOptions,
	DEFAULT_JOB_OPTIONS,
	QUEUE_NAMES,
} from "../queue/names";

const documentId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const generationId = "33333333-3333-4333-8333-333333333333";
const {
	createEmbedBatchJobSchema,
	enqueueDocumentPipelineSchema,
	JOB_IDS,
	prepareJobSchema,
} = contracts;

describe("versioned queue contracts", () => {
	test("applies validated runtime retry and retention settings", () => {
		configureDefaultJobOptions({
			attempts: 7,
			retryBaseDelayMs: 2_500,
			completedRetentionCount: 12,
			failedRetentionCount: 34,
		});
		expect(DEFAULT_JOB_OPTIONS).toMatchObject({
			attempts: 7,
			backoff: { delay: 2_500 },
			removeOnComplete: { count: 12 },
			removeOnFail: { count: 34 },
		});
		configureDefaultJobOptions({
			attempts: 5,
			retryBaseDelayMs: 1_000,
			completedRetentionCount: 1_000,
			failedRetentionCount: 5_000,
		});
	});

	test("uses BullMQ-valid queue names without Redis key separators", () => {
		expect(Object.values(QUEUE_NAMES)).toEqual([
			"hiai-docs-prepare-v1",
			"hiai-docs-embed-v1",
			"hiai-docs-graph-v1",
			"hiai-docs-summarize-v1",
			"hiai-docs-finalize-v1",
		]);
		expect(
			Object.values(QUEUE_NAMES).every((name) => !name.includes(":")),
		).toBe(true);
	});
	test("rejects missing owners, invalid UUIDs, sources, and schema versions", () => {
		expect(
			enqueueDocumentPipelineSchema.safeParse({
				documentId,
				revision: "rev-1",
				source: "interactive",
			}).success,
		).toBe(false);
		expect(
			enqueueDocumentPipelineSchema.safeParse({
				documentId: "not-a-uuid",
				ownerId,
				revision: "rev-1",
				source: "unknown",
			}).success,
		).toBe(false);
		expect(
			prepareJobSchema.safeParse({
				schemaVersion: 3,
				stage: "prepare",
				documentId,
				ownerId,
				generationId,
				revision: "rev-1",
				requestedAt: new Date().toISOString(),
				source: "interactive",
			}).success,
		).toBe(false);
	});

	test("decodes legacy v1 prepare jobs as explicit full-refresh v2 jobs", () => {
		const decodePrepareJob = Reflect.get(contracts, "decodePrepareJob") as
			| ((value: unknown) => Record<string, unknown>)
			| undefined;
		expect(decodePrepareJob).toBeFunction();
		if (!decodePrepareJob) return;
		const decoded = decodePrepareJob({
			schemaVersion: 1,
			stage: "prepare",
			documentId,
			ownerId,
			generationId,
			revision: "rev-1",
			requestedAt: new Date(0).toISOString(),
			source: "interactive",
		});

		expect(decoded).toMatchObject({
			schemaVersion: 2,
			refreshMode: "full",
		});
	});

	test("does not treat a refresh-less v2 prepare job as legacy", () => {
		expect(
			prepareJobSchema.safeParse({
				schemaVersion: 2,
				stage: "prepare",
				documentId,
				ownerId,
				generationId,
				revision: "rev-1",
				requestedAt: new Date(0).toISOString(),
				source: "interactive",
			}).success,
		).toBe(false);
	});

	test("accepts an optional workspace context for durable jobs", () => {
		const parsed = enqueueDocumentPipelineSchema.safeParse({
			documentId,
			ownerId,
			workspaceId: "workspace-a",
			revision: "rev-1",
			source: "interactive",
		});
		expect(parsed.success).toBe(true);
	});

	test("bounds embed batch indexes and chunk counts", () => {
		const schema = createEmbedBatchJobSchema(2);
		const base = {
			schemaVersion: 1,
			stage: "embed",
			documentId,
			ownerId,
			generationId,
			revision: "rev-1",
			requestedAt: new Date().toISOString(),
			source: "interactive",
			totalBatches: 1,
		};
		expect(
			schema.safeParse({ ...base, batchIndex: -1, chunkIndexes: [0] }).success,
		).toBe(false);
		expect(
			schema.safeParse({ ...base, batchIndex: 0, chunkIndexes: [0, 1, 2] })
				.success,
		).toBe(false);
		expect(
			schema.safeParse({ ...base, batchIndex: 0, chunkIndexes: [0, 1] })
				.success,
		).toBe(true);
	});

	test("builds deterministic stage job identifiers", () => {
		expect(JOB_IDS.prepare(documentId, generationId)).toBe(
			`prepare-${documentId}-${generationId}`,
		);
		expect(JOB_IDS.embed(generationId, 3)).toBe(`embed-${generationId}-3`);
		expect(JOB_IDS.graph(generationId)).toBe(`graph-${generationId}`);
		expect(JOB_IDS.summarize(generationId)).toBe(`summary-${generationId}`);
		expect(JOB_IDS.finalize(generationId)).toBe(`finalize-${generationId}`);
		expect(
			[
				JOB_IDS.prepare(documentId, generationId),
				JOB_IDS.embed(generationId, 3),
				JOB_IDS.graph(generationId),
				JOB_IDS.summarize(generationId),
				JOB_IDS.finalize(generationId),
			].every((id) => !id.includes(":")),
		).toBe(true);
	});
});
