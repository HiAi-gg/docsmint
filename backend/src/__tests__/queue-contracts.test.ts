import { describe, expect, test } from "bun:test";
import {
	createEmbedBatchJobSchema,
	enqueueDocumentPipelineSchema,
	JOB_IDS,
	prepareJobSchema,
} from "../queue/contracts";

const documentId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const generationId = "33333333-3333-4333-8333-333333333333";

describe("versioned queue contracts", () => {
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
				schemaVersion: 2,
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
			`prepare:${documentId}:${generationId}`,
		);
		expect(JOB_IDS.embed(generationId, 3)).toBe(`embed:${generationId}:3`);
		expect(JOB_IDS.graph(generationId)).toBe(`graph:${generationId}`);
		expect(JOB_IDS.summarize(generationId)).toBe(`summary:${generationId}`);
		expect(JOB_IDS.finalize(generationId)).toBe(`finalize:${generationId}`);
	});
});
