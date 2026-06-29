-- hiai-docs unified init.sql
-- Runs on first PostgreSQL startup via docker-entrypoint-initdb.d.
--
-- Installs the four extensions we need and creates the AGE graph. All
-- relational tables / indexes / FKs are applied later via Drizzle
-- migrations (packages/db/src/migrations), so this file is purely the
-- extension layer.

-- Vector search + StreamingDiskANN (pgvectorscale requires pgvector).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS vectorscale;

-- Knowledge graph (Apache AGE). The ag_catalog schema is created
-- automatically by the extension. We then set `search_path` to make
-- `ag_catalog` reachable for Cypher queries and operator class
-- lookups (`graphid_ops` lives there, and AGE's `cypher()` function
-- has `agtype` parameters that PG can only resolve if ag_catalog
-- is in the search path).
CREATE EXTENSION IF NOT EXISTS age;

-- Set search_path SESSION-LOCAL for the rest of this script so
-- `create_graph` and `cypher()` calls resolve ag_catalog types and
-- operator classes without the schema prefix. `ALTER DATABASE ... SET`
-- alone is not enough — it only affects new sessions, not the one
-- currently running this init script.
SET search_path = ag_catalog, public;

-- Create the AGE graph. Idempotent: `create_graph` raises if the
-- graph already exists, so we wrap in a DO block and swallow
-- "already exists" specifically.
DO $$
BEGIN
  PERFORM create_graph('docs_graph');
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT LIKE '%already exists%' THEN
    RAISE;
  END IF;
END
$$;

-- Trigram indexes for fuzzy / similarity search on document titles and
-- tag names (used by `/api/search/suggest` and tag autocomplete).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

GRANT ALL PRIVILEGES ON DATABASE hiai_docs TO aiuser;
GRANT ALL PRIVILEGES ON SCHEMA public TO aiuser;
GRANT ALL PRIVILEGES ON SCHEMA ag_catalog TO aiuser;
