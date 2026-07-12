CREATE TYPE "embedding_status" AS ENUM ('pending', 'processing', 'ready', 'failed', 'stale');--> statement-breakpoint

ALTER TABLE "documents"
  ADD COLUMN "embedding_status" "embedding_status",
  ADD COLUMN "active_embedding_generation" uuid,
  ADD COLUMN "pending_embedding_generation" uuid,
  ADD COLUMN "embedding_profile" text,
  ADD COLUMN "embedding_error_code" text,
  ADD COLUMN "embedding_updated_at" timestamp;--> statement-breakpoint

ALTER TABLE "document_embeddings"
  ADD COLUMN "generation_id" uuid,
  ADD COLUMN "embedding_dimensions" integer,
  ADD COLUMN "embedding_profile" text,
  ADD COLUMN "is_valid" boolean;--> statement-breakpoint

WITH generations AS (
  SELECT document_id, gen_random_uuid() AS generation_id
  FROM (SELECT DISTINCT document_id FROM document_embeddings) AS legacy_documents
)
UPDATE document_embeddings AS de
SET generation_id = g.generation_id
FROM generations AS g
WHERE g.document_id = de.document_id;--> statement-breakpoint

UPDATE document_embeddings
SET
  embedding_dimensions = COALESCE(vector_dims(embedding), 0),
  embedding_profile = COALESCE(NULLIF(embedding_model, ''), 'legacy'),
  is_valid = (
    embedding IS NOT NULL
    AND vector_dims(embedding) = 1024
    AND vector_norm(embedding) > 0
    AND embedding_model <> ''
  );--> statement-breakpoint

WITH generation_state AS (
  SELECT
    document_id,
    MIN(generation_id::text)::uuid AS generation_id,
    MIN(embedding_profile) AS embedding_profile,
    BOOL_AND(is_valid) AS all_rows_valid
  FROM document_embeddings
  GROUP BY document_id
)
UPDATE documents AS d
SET
  active_embedding_generation = state.generation_id,
  embedding_profile = state.embedding_profile,
  embedding_status = CASE
    WHEN state.all_rows_valid THEN 'ready'::embedding_status
    ELSE 'stale'::embedding_status
  END,
  embedding_updated_at = now()
FROM generation_state AS state
WHERE state.document_id = d.id;--> statement-breakpoint

UPDATE documents
SET embedding_status = 'stale'::embedding_status
WHERE active_embedding_generation IS NULL;--> statement-breakpoint

ALTER TABLE "documents"
  ALTER COLUMN "embedding_status" SET DEFAULT 'pending',
  ALTER COLUMN "embedding_status" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "document_embeddings"
  ALTER COLUMN "generation_id" SET NOT NULL,
  ALTER COLUMN "embedding_dimensions" SET DEFAULT 1024,
  ALTER COLUMN "embedding_dimensions" SET NOT NULL,
  ALTER COLUMN "embedding_profile" SET DEFAULT 'legacy',
  ALTER COLUMN "embedding_profile" SET NOT NULL,
  ALTER COLUMN "is_valid" SET DEFAULT false,
  ALTER COLUMN "is_valid" SET NOT NULL;--> statement-breakpoint

DROP INDEX IF EXISTS "document_embeddings_doc_chunk_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "document_embeddings_doc_chunk_idx"
  ON "document_embeddings" USING btree ("document_id", "generation_id", "chunk_index");--> statement-breakpoint

CREATE INDEX "document_embeddings_generation_valid_idx"
  ON "document_embeddings" USING btree ("document_id", "generation_id", "is_valid");--> statement-breakpoint
CREATE INDEX "documents_embedding_status_idx"
  ON "documents" USING btree ("embedding_status");--> statement-breakpoint

ALTER TABLE "documents"
  ADD COLUMN "search_vector_simple" tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', COALESCE(title, '') || ' ' || COALESCE(content, ''))) STORED;--> statement-breakpoint
CREATE INDEX "idx_documents_search_vector_simple"
  ON "documents" USING gin ("search_vector_simple");
