import { z } from "zod";

export const PIPELINE_SCHEMA_VERSION = 2 as const;
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
export const pipelineRefreshModeSchema = z.enum(["incremental", "full"]);
export type PipelineRefreshMode = z.infer<typeof pipelineRefreshModeSchema>;

const basePipelineJobFields = {
	schemaVersion: z.literal(PIPELINE_SCHEMA_VERSION),
	documentId: z.uuid(),
	ownerId: z.uuid(),
	workspaceId: z.string().min(1).optional(),
	generationId: z.uuid(),
	revision: z.string().min(1),
	requestedAt: z.iso.datetime(),
	source: pipelineSourceSchema,
	refreshMode: pipelineRefreshModeSchema,
	embeddingContextHash: z.string().min(1).optional(),
} as const;

function normalizeLegacyPipelineJob(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const job = value as Record<string, unknown>;
	if (job.schemaVersion !== 1) return value;
	return {
		...job,
		schemaVersion: PIPELINE_SCHEMA_VERSION,
		refreshMode: "full",
	};
}

const prepareJobV2Schema = z.object({
	...basePipelineJobFields,
	stage: z.literal("prepare"),
});

export const prepareJobSchema = z.preprocess(
	normalizeLegacyPipelineJob,
	prepareJobV2Schema,
);
export type PrepareJob = z.infer<typeof prepareJobSchema>;

export function decodePrepareJob(value: unknown): PrepareJob {
	return prepareJobSchema.parse(value);
}

export function createEmbedBatchJobSchema(
	maxChunkCount = MAX_EMBED_CHUNKS_PER_JOB,
) {
	const schema = z.object({
		...basePipelineJobFields,
		stage: z.literal("embed"),
		batchIndex: z.number().int().nonnegative(),
		totalBatches: z.number().int().positive(),
		chunkIndexes: z
			.array(z.number().int().nonnegative())
			.min(1)
			.max(maxChunkCount),
	});
	return z.preprocess(normalizeLegacyPipelineJob, schema);
}

export const embedBatchJobSchema = createEmbedBatchJobSchema();
export type EmbedBatchJob = z.infer<typeof embedBatchJobSchema>;

const graphJobV2Schema = z.object({
	...basePipelineJobFields,
	stage: z.literal("graph"),
});
const summarizeJobV2Schema = z.object({
	...basePipelineJobFields,
	stage: z.literal("summarize"),
});
const finalizeJobV2Schema = z.object({
	...basePipelineJobFields,
	stage: z.literal("finalize"),
});
export const graphJobSchema = z.preprocess(
	normalizeLegacyPipelineJob,
	graphJobV2Schema,
);
export const summarizeJobSchema = z.preprocess(
	normalizeLegacyPipelineJob,
	summarizeJobV2Schema,
);
export const finalizeJobSchema = z.preprocess(
	normalizeLegacyPipelineJob,
	finalizeJobV2Schema,
);

export type PipelineStage =
	| "prepare"
	| "embed"
	| "graph"
	| "summarize"
	| "finalize";

const embedBatchJobV2Schema = z.object({
	...basePipelineJobFields,
	stage: z.literal("embed"),
	batchIndex: z.number().int().nonnegative(),
	totalBatches: z.number().int().positive(),
	chunkIndexes: z
		.array(z.number().int().nonnegative())
		.min(1)
		.max(MAX_EMBED_CHUNKS_PER_JOB),
});

export const pipelineJobSchema = z.preprocess(
	normalizeLegacyPipelineJob,
	z.discriminatedUnion("stage", [
		prepareJobV2Schema,
		embedBatchJobV2Schema,
		graphJobV2Schema,
		summarizeJobV2Schema,
		finalizeJobV2Schema,
	]),
);
export type PipelineJob = z.infer<typeof pipelineJobSchema>;

export const enqueueDocumentPipelineSchema = z.object({
	documentId: z.uuid(),
	ownerId: z.uuid(),
	workspaceId: z.string().min(1).optional(),
	generationId: z.uuid().optional(),
	revision: z.string().min(1),
	source: pipelineSourceSchema,
	requestedAt: z.iso.datetime().optional(),
	forceNewGeneration: z.boolean().optional(),
	refreshMode: pipelineRefreshModeSchema.optional(),
});
export type EnqueueDocumentPipelineInput = z.infer<
	typeof enqueueDocumentPipelineSchema
>;

export const JOB_IDS = {
	prepare: (documentId: string, generationId: string, workspaceId?: string) =>
		`prepare-${documentId}-${generationId}${workspaceId ? `-${workspaceId}` : ""}`,
	embed: (generationId: string, batchIndex: number, workspaceId?: string) =>
		`embed-${generationId}-${batchIndex}${workspaceId ? `-${workspaceId}` : ""}`,
	graph: (generationId: string, workspaceId?: string) =>
		`graph-${generationId}${workspaceId ? `-${workspaceId}` : ""}`,
	summarize: (generationId: string, workspaceId?: string) =>
		`summary-${generationId}${workspaceId ? `-${workspaceId}` : ""}`,
	finalize: (generationId: string, workspaceId?: string) =>
		`finalize-${generationId}${workspaceId ? `-${workspaceId}` : ""}`,
} as const;
