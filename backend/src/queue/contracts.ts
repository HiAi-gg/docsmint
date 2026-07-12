import { z } from "zod";

export const PIPELINE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_EMBED_CHUNKS_PER_JOB = 5;
export const MAX_EMBED_CHUNKS_PER_JOB = 32;

export const pipelineSourceSchema = z.enum([
	"interactive",
	"import",
	"api",
	"reindex",
	"backfill",
]);
export type PipelineSource = z.infer<typeof pipelineSourceSchema>;

const basePipelineJobSchema = z.object({
	schemaVersion: z.literal(PIPELINE_SCHEMA_VERSION),
	documentId: z.uuid(),
	ownerId: z.uuid(),
	generationId: z.uuid(),
	revision: z.string().min(1),
	requestedAt: z.iso.datetime(),
	source: pipelineSourceSchema,
});

export const prepareJobSchema = basePipelineJobSchema.extend({
	stage: z.literal("prepare"),
});
export type PrepareJob = z.infer<typeof prepareJobSchema>;

export function createEmbedBatchJobSchema(
	maxChunkCount = MAX_EMBED_CHUNKS_PER_JOB,
) {
	return basePipelineJobSchema.extend({
		stage: z.literal("embed"),
		batchIndex: z.number().int().nonnegative(),
		totalBatches: z.number().int().positive(),
		chunkIndexes: z
			.array(z.number().int().nonnegative())
			.min(1)
			.max(maxChunkCount),
	});
}

export const embedBatchJobSchema = createEmbedBatchJobSchema();
export type EmbedBatchJob = z.infer<typeof embedBatchJobSchema>;

export const graphJobSchema = basePipelineJobSchema.extend({
	stage: z.literal("graph"),
});
export const summarizeJobSchema = basePipelineJobSchema.extend({
	stage: z.literal("summarize"),
});
export const finalizeJobSchema = basePipelineJobSchema.extend({
	stage: z.literal("finalize"),
});

export type PipelineStage =
	| "prepare"
	| "embed"
	| "graph"
	| "summarize"
	| "finalize";

export const pipelineJobSchema = z.discriminatedUnion("stage", [
	prepareJobSchema,
	embedBatchJobSchema,
	graphJobSchema,
	summarizeJobSchema,
	finalizeJobSchema,
]);
export type PipelineJob = z.infer<typeof pipelineJobSchema>;

export const enqueueDocumentPipelineSchema = z.object({
	documentId: z.uuid(),
	ownerId: z.uuid(),
	revision: z.string().min(1),
	source: pipelineSourceSchema,
	requestedAt: z.iso.datetime().optional(),
});
export type EnqueueDocumentPipelineInput = z.infer<
	typeof enqueueDocumentPipelineSchema
>;

export const JOB_IDS = {
	prepare: (documentId: string, generationId: string) =>
		`prepare-${documentId}-${generationId}`,
	embed: (generationId: string, batchIndex: number) =>
		`embed-${generationId}-${batchIndex}`,
	graph: (generationId: string) => `graph-${generationId}`,
	summarize: (generationId: string) => `summary-${generationId}`,
	finalize: (generationId: string) => `finalize-${generationId}`,
} as const;
