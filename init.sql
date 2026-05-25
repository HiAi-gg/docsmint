-- hiai-docs init.sql
-- Runs on first PostgreSQL startup via docker-entrypoint-initdb.d

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

GRANT ALL PRIVILEGES ON DATABASE hiai_docs TO aiuser;
GRANT ALL PRIVILEGES ON SCHEMA public TO aiuser;

-- Full-text search: add tsvector column and GIN index
ALTER TABLE documents ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(content, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_documents_search_vector ON documents USING gin (search_vector);

-- Trigram index for suggest endpoint
CREATE INDEX IF NOT EXISTS idx_documents_title_trgm ON documents USING gin (title gin_trgm_ops);

-- HNSW vector index for semantic search
CREATE INDEX IF NOT EXISTS idx_document_embeddings_hnsw ON document_embeddings USING hnsw (embedding vector_cosine_ops);

-- Folders self-reference: cascade on delete
ALTER TABLE folders ADD CONSTRAINT fk_folders_parent
  FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE SET NULL;

-- Self-referencing FK for folders.parentId (set null on delete)
ALTER TABLE folders DROP CONSTRAINT IF EXISTS folders_parent_id_fk;
ALTER TABLE folders ADD CONSTRAINT folders_parent_id_fk
  FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE SET NULL;
