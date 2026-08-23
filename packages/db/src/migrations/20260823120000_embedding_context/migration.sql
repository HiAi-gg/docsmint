ALTER TABLE "documents" ADD COLUMN "embedding_context_hash" text;
--> statement-breakpoint
ALTER TABLE "document_pipeline_runs" ADD COLUMN "embedding_context_hash" text;
--> statement-breakpoint
ALTER TABLE "document_pipeline_runs" ADD COLUMN "refresh_mode" text DEFAULT 'full' NOT NULL;
--> statement-breakpoint
ALTER TABLE "document_pipeline_runs" ADD CONSTRAINT "document_pipeline_runs_refresh_mode_check" CHECK ("document_pipeline_runs"."refresh_mode" in ('incremental', 'full'));
