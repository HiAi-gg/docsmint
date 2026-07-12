import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	documentPipelineBatches,
	documentPipelineRuns,
	pipelineStageEnum,
	pipelineStatusEnum,
} from "./schema";

const migration = readFileSync(
	new URL("./migrations/0028_bullmq_pipeline_state.sql", import.meta.url),
	"utf8",
);
const privilegeMigration = readFileSync(
	new URL("./migrations/0029_grant_pipeline_runtime.sql", import.meta.url),
	"utf8",
);
const relocationMigration = readFileSync(
	new URL(
		"./migrations/0030_move_pipeline_tables_to_public.sql",
		import.meta.url,
	),
	"utf8",
);
const rlsMigration = readFileSync(
	new URL("./migrations/0031_pipeline_tenant_rls.sql", import.meta.url),
	"utf8",
);
const journal = JSON.parse(
	readFileSync(
		new URL("./migrations/meta/_journal.json", import.meta.url),
		"utf8",
	),
) as { entries: Array<{ idx: number; tag: string }> };

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
				"documentId",
				"ownerId",
				"generationId",
				"revision",
				"source",
				"status",
				"prepareStatus",
				"embedStatus",
				"graphStatus",
				"summarizeStatus",
				"finalizeStatus",
				"totalBatches",
				"completedBatches",
				"failedBatches",
				"errorCode",
				"attempts",
				"heartbeatAt",
				"updatedAt",
			]),
		);
		expect(Object.keys(documentPipelineBatches)).toEqual(
			expect.arrayContaining([
				"documentId",
				"generationId",
				"batchIndex",
				"stage",
				"chunkStart",
				"chunkEnd",
				"status",
				"attempts",
				"embeddingProfile",
				"availableAt",
			]),
		);
		expect(Object.keys(documentPipelineRuns)).not.toContain("content");
		expect(Object.keys(documentPipelineBatches)).not.toContain("modelOutput");
	});

	it("contains idempotency, scheduling, and document cascade constraints", () => {
		expect(migration).toContain('UNIQUE("document_id", "generation_id")');
		expect(migration).toContain('UNIQUE("generation_id", "batch_index")');
		expect(migration).toContain('("owner_id", "status", "updated_at")');
		expect(migration).toContain('("stage", "status", "available_at")');
		expect(
			migration.match(
				/REFERENCES public\."documents"\("id"\) ON DELETE CASCADE/g,
			),
		).toHaveLength(2);
		expect(migration).toContain(
			'CREATE TABLE IF NOT EXISTS public."document_pipeline_runs"',
		);
		expect(migration).toContain(
			'CREATE TABLE IF NOT EXISTS public."document_pipeline_batches"',
		);
		expect(migration).toContain('CREATE TYPE public."pipeline_stage"');
		expect(migration).toContain('CREATE TYPE public."pipeline_status"');
	});

	it("grants pipeline runtime access in fresh and upgraded migration chains", () => {
		expect(privilegeMigration).toContain(
			"to_regclass('public.' || table_name)",
		);
		expect(privilegeMigration).toContain(
			"to_regclass('ag_catalog.' || table_name)",
		);
		expect(privilegeMigration).toContain(
			"GRANT SELECT, INSERT, UPDATE, DELETE",
		);
		expect(privilegeMigration).toContain("TO hiai_app");
		expect(privilegeMigration).toContain(
			"ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public",
		);
		expect(relocationMigration).toContain(
			"ALTER TABLE ag_catalog.document_pipeline_runs SET SCHEMA public",
		);
		expect(relocationMigration).toContain(
			"ALTER TABLE ag_catalog.document_pipeline_batches SET SCHEMA public",
		);
		expect(relocationMigration).toContain(
			"ALTER TYPE ag_catalog.pipeline_stage SET SCHEMA public",
		);
		expect(relocationMigration).toContain(
			"ALTER TYPE ag_catalog.pipeline_status SET SCHEMA public",
		);
		expect(journal.entries.find((entry) => entry.idx === 31)).toMatchObject({
			idx: 31,
			tag: "0031_pipeline_tenant_rls",
		});
	});

	it("forces tenant RLS on runs and scopes batches through their parent run", () => {
		expect(rlsMigration).toContain(
			"ALTER TABLE public.document_pipeline_runs FORCE ROW LEVEL SECURITY",
		);
		expect(rlsMigration).toContain(
			"ALTER TABLE public.document_pipeline_batches FORCE ROW LEVEL SECURITY",
		);
		expect(rlsMigration).toContain("FOR ALL TO hiai_app");
		expect(rlsMigration).toContain(
			"owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid",
		);
		expect(rlsMigration).toContain(
			"current_setting('app.current_user_role', true) = 'admin'",
		);
		expect(rlsMigration).toContain(
			"pipeline_parent.generation_id = document_pipeline_batches.generation_id",
		);
		expect(rlsMigration).toContain(
			"pipeline_parent.document_id = document_pipeline_batches.document_id",
		);
		expect(rlsMigration).toContain("pipeline_migration_owner_access");
	});
});
