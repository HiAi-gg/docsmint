-- hiai-docs unified init.sql
-- Runs on first PostgreSQL startup via docker-entrypoint-initdb.d.
--
-- Bootstraps database infrastructure: required extensions plus owner-role
-- database/search_path configuration. Graph objects, labels, graph indexes,
-- and all application tables / indexes / FKs are applied later via Drizzle
-- migrations (packages/db/src/migrations). This script MUST NOT create
-- application or GraphRAG objects or grant their runtime privileges.

-- Vector search + StreamingDiskANN (pgvectorscale requires pgvector).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS vectorscale;

-- Knowledge graph (Apache AGE). The ag_catalog schema is created
-- automatically by the extension. Graph objects are deliberately owned by
-- the Drizzle migration journal, not by this bootstrap script.
CREATE EXTENSION IF NOT EXISTS age;

-- Load the AGE shared library into every new session so cypher() works.
-- CREATE EXTENSION installs the SQL definitions but does NOT load the
-- .so into the process. Without this, cypher() raises "unhandled
-- cypher(cstring) function call" because AGE's parser/planner hooks
-- are never registered. This must be a database-level setting (not
-- session-local) so it applies to every connection in the pool.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET session_preload_libraries = %L', current_database(), 'age');
END
$$;

-- Trigram indexes for fuzzy / similarity search on document titles and
-- tag names (used by `/api/search/suggest` and tag autocomplete).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Grant privileges on the current database dynamically. The database
-- name is set via POSTGRES_DB at container start and may differ between
-- local (`hiai_docs`), CI (`hiai_docs_test`), or any other environment,
-- so we resolve it at runtime rather than hardcoding it.
DO $$
BEGIN
  EXECUTE format('GRANT ALL PRIVILEGES ON DATABASE %I TO aiuser', current_database());
END
$$;
GRANT ALL PRIVILEGES ON SCHEMA public TO aiuser;
GRANT ALL PRIVILEGES ON SCHEMA ag_catalog TO aiuser;

-- Pin the search_path for every connection owned by `aiuser`. ORDER
-- MATTERS: `public` must come first so that Drizzle/Better Auth
-- resolve unqualified table names like `documents` to
-- `public.documents` instead of `ag_catalog.documents`. `ag_catalog`
-- is kept second so that AGE's `agtype`/`graphid_ops` still resolve
-- without the schema prefix. The session-local `SET search_path`
-- above only affects the current docker-entrypoint-initdb.d session;
-- this ALTER ROLE persists across the connection pool.
ALTER ROLE aiuser SET search_path = public, ag_catalog;

-- The non-superuser runtime role is created by 01-runtime-role.sh with the
-- operator-provided HIAI_APP_PASSWORD before Drizzle migrations run. The
-- role's grants and search_path are finalized by migration 0012.
