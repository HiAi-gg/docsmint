-- The initial document_embeddings table omitted chunk_hash even though the
-- Drizzle schema and embedding workers have always treated it as optional.
-- Keep this nullable so legacy rows remain valid and can be backfilled during
-- a later reindex without blocking an upgraded installation.
ALTER TABLE "document_embeddings"
  ADD COLUMN IF NOT EXISTS "chunk_hash" text;
