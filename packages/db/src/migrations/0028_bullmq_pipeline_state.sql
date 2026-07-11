-- Durable PostgreSQL state for the BullMQ GraphRAG pipeline.
-- Queue payloads remain small; document bodies and model output are never stored here.
DO $$ BEGIN
  CREATE TYPE "pipeline_stage" AS ENUM ('prepare', 'embed', 'graph', 'summarize', 'finalize');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "pipeline_status" AS ENUM ('pending', 'processing', 'ready', 'retrying', 'failed', 'skipped', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TYPE "pipeline_status" ADD VALUE IF NOT EXISTS 'ready_with_warnings';

CREATE TABLE IF NOT EXISTS "document_pipeline_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "generation_id" uuid NOT NULL,
  "revision" text NOT NULL,
  "source" text NOT NULL,
  "status" "pipeline_status" DEFAULT 'pending' NOT NULL,
  "prepare_status" "pipeline_status" DEFAULT 'pending' NOT NULL,
  "embed_status" "pipeline_status" DEFAULT 'pending' NOT NULL,
  "graph_status" "pipeline_status" DEFAULT 'pending' NOT NULL,
  "summarize_status" "pipeline_status" DEFAULT 'pending' NOT NULL,
  "finalize_status" "pipeline_status" DEFAULT 'pending' NOT NULL,
  "total_batches" integer DEFAULT 0 NOT NULL,
  "completed_batches" integer DEFAULT 0 NOT NULL,
  "failed_batches" integer DEFAULT 0 NOT NULL,
  "error_code" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "requested_at" timestamp DEFAULT now() NOT NULL,
  "started_at" timestamp,
  "completed_at" timestamp,
  "heartbeat_at" timestamp,
  "available_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "document_pipeline_runs_document_generation_unique" UNIQUE("document_id", "generation_id")
);

CREATE INDEX IF NOT EXISTS "document_pipeline_runs_owner_status_updated_idx"
  ON "document_pipeline_runs" USING btree ("owner_id", "status", "updated_at");

CREATE TABLE IF NOT EXISTS "document_pipeline_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "generation_id" uuid NOT NULL,
  "batch_index" integer NOT NULL,
  "stage" "pipeline_stage" DEFAULT 'embed' NOT NULL,
  "chunk_start" integer NOT NULL,
  "chunk_end" integer NOT NULL,
  "status" "pipeline_status" DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "embedding_profile" text,
  "error_code" text,
  "available_at" timestamp,
  "started_at" timestamp,
  "completed_at" timestamp,
  "heartbeat_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "document_pipeline_batches_generation_index_unique" UNIQUE("generation_id", "batch_index")
);

CREATE INDEX IF NOT EXISTS "document_pipeline_batches_stage_status_available_idx"
  ON "document_pipeline_batches" USING btree ("stage", "status", "available_at");
CREATE INDEX IF NOT EXISTS "document_pipeline_batches_document_id_idx"
  ON "document_pipeline_batches" USING btree ("document_id");
