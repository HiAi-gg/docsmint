import { documentPipelineRuns, documents } from "@hiai-docs/db/schema";
import { withTenant } from "@hiai-docs/db/with-tenant";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { acquireDocumentPipelineLock } from "../lib/document-pipeline-serialization";
import {
	type EnqueueDocumentPipelineInput,
	enqueueDocumentPipelineSchema,
	JOB_IDS,
	PIPELINE_SCHEMA_VERSION,
	type PipelineRefreshMode,
	type PrepareJob,
} from "./contracts";
import { DEFAULT_JOB_OPTIONS, SOURCE_PRIORITY } from "./names";

type ActiveRun = Pick<
	typeof documentPipelineRuns.$inferSelect,
	"generationId" | "status" | "prepareStatus"
>;

export interface PipelineRunStore {
	isCancelled(input: {
		ownerId: string;
		generationId: string;
		workspaceId?: string;
	}): Promise<boolean>;
	findOrCreate(input: {
		documentId: string;
		ownerId: string;
		revision: string;
		source: EnqueueDocumentPipelineInput["source"];
		requestedAt: Date;
		generationId: string;
		workspaceId?: string;
		forceNewGeneration?: boolean;
		refreshMode: PipelineRefreshMode;
	}): Promise<{ run: ActiveRun; created: boolean }>;
}

export interface PrepareQueueWriter {
	add(
		name: string,
		data: PrepareJob,
		options: {
			jobId: string;
			priority: number;
			attempts: number;
			backoff: { type: string; delay: number };
			removeOnComplete: { count: number };
			removeOnFail: { count: number };
		},
	): Promise<{ remove(): Promise<void> }>;
}

export type MetadataReembedPrepareJob = Readonly<{
	outboxId: string;
	documentId: string;
	ownerId: string;
	workspaceId?: string;
	generationId: string;
	revision: string;
	requestedAt: string;
}>;

export interface PrepareBulkQueueWriter {
	addBulk(
		jobs: Array<{
			name: "prepare";
			data: PrepareJob;
			opts: {
				jobId: string;
				priority: number;
				attempts: number;
				backoff: { type: string; delay: number };
				removeOnComplete: { count: number };
				removeOnFail: { count: number };
			};
		}>,
	): Promise<ReadonlyArray<{ data: PrepareJob }>>;
}

export interface EnqueueDependencies {
	runs: PipelineRunStore;
	prepareQueue: PrepareQueueWriter;
}

const ACTIVE_STATUSES = ["pending", "processing", "retrying"] as const;

const postgresRunStore: PipelineRunStore = {
	async isCancelled(input) {
		return withTenant(
			{ userId: input.ownerId, role: "user", workspaceId: input.workspaceId },
			async (tx) => {
				const boundary = input.workspaceId
					? eq(documentPipelineRuns.workspaceId, input.workspaceId)
					: and(
							isNull(documentPipelineRuns.workspaceId),
							eq(documentPipelineRuns.ownerId, input.ownerId),
						);
				const [run] = await tx
					.select({ status: documentPipelineRuns.status })
					.from(documentPipelineRuns)
					.where(
						and(
							eq(documentPipelineRuns.generationId, input.generationId),
							boundary,
						),
					)
					.limit(1);
				return run?.status === "cancelled";
			},
		);
	},
	async findOrCreate(input) {
		const ownerBoundary = input.workspaceId
			? eq(documents.workspaceId, input.workspaceId)
			: and(
					isNull(documents.workspaceId),
					eq(documents.ownerId, input.ownerId),
				);
		const runBoundary = input.workspaceId
			? eq(documentPipelineRuns.workspaceId, input.workspaceId)
			: and(
					isNull(documentPipelineRuns.workspaceId),
					eq(documentPipelineRuns.ownerId, input.ownerId),
				);
		return withTenant(
			{ userId: input.ownerId, role: "user", workspaceId: input.workspaceId },
			async (tx) => {
				await acquireDocumentPipelineLock(tx, input.documentId);
				const [document] = await tx
					.select({ id: documents.id })
					.from(documents)
					.where(and(eq(documents.id, input.documentId), ownerBoundary))
					.limit(1);
				if (!document) throw new Error("Document not found for pipeline owner");
				const [exactGeneration] = await tx
					.select({
						generationId: documentPipelineRuns.generationId,
						status: documentPipelineRuns.status,
						prepareStatus: documentPipelineRuns.prepareStatus,
					})
					.from(documentPipelineRuns)
					.where(
						and(
							eq(documentPipelineRuns.documentId, input.documentId),
							runBoundary,
							eq(documentPipelineRuns.generationId, input.generationId),
						),
					)
					.limit(1);
				if (exactGeneration) return { run: exactGeneration, created: false };
				if (input.forceNewGeneration) {
					await tx
						.update(documentPipelineRuns)
						.set({
							status: "cancelled",
							errorCode: "superseded_by_reindex",
							updatedAt: new Date(),
						})
						.where(
							and(
								eq(documentPipelineRuns.documentId, input.documentId),
								runBoundary,
								inArray(documentPipelineRuns.status, [...ACTIVE_STATUSES]),
							),
						);
				}

				const [existing] = input.forceNewGeneration
					? []
					: await tx
							.select({
								generationId: documentPipelineRuns.generationId,
								status: documentPipelineRuns.status,
								prepareStatus: documentPipelineRuns.prepareStatus,
							})
							.from(documentPipelineRuns)
							.where(
								and(
									eq(documentPipelineRuns.documentId, input.documentId),
									runBoundary,
									eq(documentPipelineRuns.revision, input.revision),
									inArray(documentPipelineRuns.status, [...ACTIVE_STATUSES]),
								),
							)
							.limit(1);
				if (existing) return { run: existing, created: false };

				const [created] = await tx
					.insert(documentPipelineRuns)
					.values({
						documentId: input.documentId,
						ownerId: input.ownerId,
						generationId: input.generationId,
						revision: input.revision,
						source: input.source,
						refreshMode: input.refreshMode,
						requestedAt: input.requestedAt,
						workspaceId: input.workspaceId,
					})
					.returning({
						generationId: documentPipelineRuns.generationId,
						status: documentPipelineRuns.status,
						prepareStatus: documentPipelineRuns.prepareStatus,
					});
				if (!created) throw new Error("Failed to create document pipeline run");
				return { run: created, created: true };
			},
		);
	},
};

async function defaultDependencies(): Promise<EnqueueDependencies> {
	const [{ config }, { getPipelineQueue }] = await Promise.all([
		import("../lib/config"),
		import("./queues"),
	]);
	return {
		runs: postgresRunStore,
		prepareQueue: getPipelineQueue("prepare", config.REDIS_URL),
	};
}

async function defaultPrepareBulkQueueWriter(): Promise<PrepareBulkQueueWriter> {
	const [{ config }, { getPipelineQueue }] = await Promise.all([
		import("../lib/config"),
		import("./queues"),
	]);
	return getPipelineQueue(
		"prepare",
		config.REDIS_URL,
	) as unknown as PrepareBulkQueueWriter;
}

/** Queue one committed metadata-outbox page with deterministic generation jobs. */
export async function enqueueMetadataReembedPrepareJobsBulk(
	jobs: readonly MetadataReembedPrepareJob[],
	writer?: PrepareBulkQueueWriter,
): Promise<{ acceptedIds: string[]; deduplicatedIds: string[] }> {
	if (jobs.length === 0) return { acceptedIds: [], deduplicatedIds: [] };
	const queue = writer ?? (await defaultPrepareBulkQueueWriter());
	const queued = await queue.addBulk(
		jobs.map((job) => ({
			name: "prepare" as const,
			data: {
				schemaVersion: PIPELINE_SCHEMA_VERSION,
				stage: "prepare" as const,
				documentId: job.documentId,
				ownerId: job.ownerId,
				workspaceId: job.workspaceId,
				generationId: job.generationId,
				revision: job.revision,
				requestedAt: job.requestedAt,
				source: "interactive" as const,
				refreshMode: "full" as const,
			},
			opts: {
				...DEFAULT_JOB_OPTIONS,
				jobId: JOB_IDS.prepare(
					job.documentId,
					job.generationId,
					job.workspaceId,
				),
				priority: SOURCE_PRIORITY.interactive,
			},
		})),
	);
	const acceptedGenerations = new Set(
		queued.map(({ data }) => data.generationId),
	);
	return {
		acceptedIds: jobs
			.filter(({ generationId }) => acceptedGenerations.has(generationId))
			.map(({ outboxId }) => outboxId),
		deduplicatedIds: [],
	};
}

export async function enqueueDocumentPipeline(
	input: EnqueueDocumentPipelineInput,
	dependencies?: EnqueueDependencies,
): Promise<{ generationId: string; deduplicated: boolean }> {
	const parsed = enqueueDocumentPipelineSchema.parse(input);
	const requestedAt = new Date(parsed.requestedAt ?? new Date().toISOString());
	const proposedGenerationId = parsed.generationId ?? crypto.randomUUID();
	const deps = dependencies ?? (await defaultDependencies());
	const refreshMode = parsed.refreshMode ?? "incremental";
	const { run, created } = await deps.runs.findOrCreate({
		...parsed,
		refreshMode,
		requestedAt,
		generationId: proposedGenerationId,
		forceNewGeneration: parsed.forceNewGeneration,
	});
	const shouldQueuePrepare =
		created ||
		(parsed.generationId !== undefined &&
			run.status === "pending" &&
			run.prepareStatus === "pending");
	if (shouldQueuePrepare) {
		const job: PrepareJob = {
			schemaVersion: PIPELINE_SCHEMA_VERSION,
			stage: "prepare",
			documentId: parsed.documentId,
			ownerId: parsed.ownerId,
			workspaceId: parsed.workspaceId,
			generationId: run.generationId,
			revision: parsed.revision,
			requestedAt: requestedAt.toISOString(),
			source: parsed.source,
			refreshMode,
		};
		const queued = await deps.prepareQueue.add("prepare", job, {
			...DEFAULT_JOB_OPTIONS,
			jobId: JOB_IDS.prepare(
				parsed.documentId,
				run.generationId,
				parsed.workspaceId,
			),
			priority: SOURCE_PRIORITY[parsed.source],
		});
		if (
			await deps.runs.isCancelled({
				ownerId: parsed.ownerId,
				generationId: run.generationId,
				workspaceId: parsed.workspaceId,
			})
		) {
			try {
				await queued.remove();
			} catch (error) {
				const message =
					error instanceof Error ? error.message.toLowerCase() : "";
				if (
					!message.includes("locked") &&
					!message.includes("active") &&
					!message.includes("not found")
				)
					throw error;
			}
		}
	}
	return { generationId: run.generationId, deduplicated: !created };
}
