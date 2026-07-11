import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { documentPipelineBatches, documentPipelineRuns, pipelineStageEnum, pipelineStatusEnum } from "./schema";

const migration = readFileSync(
	new URL("./migrations/0028_bullmq_pipeline_state.sql", import.meta.url),
	"utf8",
);

describe("BullMQ pipeline state schema", () => {
	it("exports the planned stage and status contracts", () => {
		expect(pipelineStageEnum.enumValues).toEqual([
			"prepare",
			"embed",
			"graph",
			"summarize",
			"finalize",
		]);
		expect(pipelineStatusEnum.enumValues).toEqual([
			"pending",
			"processing",
			"ready",
			"retrying",
			"failed",
			"ready_with_warnings",
			"skipped",
			"cancelled",
		]);
	});

	it("exposes durable run and batch fields without document bodies", () => {
		expect(Object.keys(documentPipelineRuns)).toEqual(
			expect.arrayContaining([
				"documentId", "ownerId", "generationId", "revision", "source",
				"status", "prepareStatus", "embedStatus", "graphStatus",
				"summarizeStatus", "finalizeStatus", "totalBatches",
				"completedBatches", "failedBatches", "errorCode", "attempts",
				"heartbeatAt", "updatedAt",
			]),
		);
		expect(Object.keys(documentPipelineBatches)).toEqual(
			expect.arrayContaining([
				"documentId", "generationId", "batchIndex", "stage", "chunkStart",
				"chunkEnd", "status", "attempts", "embeddingProfile", "availableAt",
			]),
		);
		expect(Object.keys(documentPipelineRuns)).not.toContain("content");
		expect(Object.keys(documentPipelineBatches)).not.toContain("modelOutput");
	});

	it("contains idempotency, scheduling, and document cascade constraints", () => {
		expect(migration).toContain(
			'UNIQUE("document_id", "generation_id")',
		);
		expect(migration).toContain(
			'UNIQUE("generation_id", "batch_index")',
		);
		expect(migration).toContain(
			'("owner_id", "status", "updated_at")',
		);
		expect(migration).toContain(
			'("stage", "status", "available_at")',
		);
		expect(migration.match(/REFERENCES "documents"\("id"\) ON DELETE CASCADE/g)).toHaveLength(2);
	});
});
