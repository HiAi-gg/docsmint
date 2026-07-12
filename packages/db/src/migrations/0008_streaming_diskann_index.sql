-- Adds a StreamingDiskANN index on document_embeddings.embedding for ANN
-- queries over the >100K row regime. DiskANN ships with the pgvectorscale
-- extension (enabled in postgres/init.sql alongside vector + age + pg_trgm).
--
-- StreamingDiskANN stores compressed vectors on disk and is preferred over
-- HNSW once the table exceeds RAM or when ANN recall/throughput trade-offs
-- matter; HNSW (created in 0001_w2_3_test.sql) is still kept because it
-- serves small (in-RAM) tables with lower latency.
--
-- pgvectorscale is an optional accelerator. The HNSW index created by the
-- base schema remains the portable vector-search path when the extension is
-- unavailable (for example, when an operator uses a stock PostgreSQL image).
-- Check the registered access method rather than only the extension name:
-- CREATE EXTENSION can succeed while a broken/incompatible image still does
-- not register `diskann`.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_am
    WHERE amname = 'diskann'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "idx_document_embeddings_diskann" ON "document_embeddings" USING diskann ("embedding" vector_cosine_ops)';
  ELSE
    RAISE NOTICE 'Skipping optional StreamingDiskANN index: diskann access method is unavailable';
  END IF;
END
$$;--> statement-breakpoint
