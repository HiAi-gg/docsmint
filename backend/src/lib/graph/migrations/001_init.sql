-- Migration 001: Apache AGE graph initialization for hiai-docs GraphRAG
--
-- Creates the `docs_graph` property graph with entity vertex labels and
-- relationship edge labels used by entity extraction and graph expansion.
--
-- This migration is intentionally idempotent: AGE's `create_graph`,
-- `create_vlabel`, and `create_elabel` all return rows (rather than raising
-- on duplicate) so re-running this file is safe.

-- Make sure the AGE extension is loaded. The Apache AGE Docker image ships
-- with the extension pre-installed at the cluster level; this statement is
-- a defensive no-op for that environment and a guard for any base image
-- where it isn't.
CREATE EXTENSION IF NOT EXISTS age;

-- Load the AGE catalog into the search_path so we can call
-- `ag_catalog.create_graph`, `ag_catalog.create_vlabel`, and
-- `ag_catalog.create_elabel` without prefixing the schema.
SET search_path = ag_catalog, "$user", public;

-- Create the property graph. SELECT wrappers around DDL functions return a
-- single row in AGE; we discard it.
SELECT * FROM ag_catalog.create_graph('docs_graph');

-- Vertex labels (entity types). Each `create_vlabel` call materializes a
-- backing table under `ag_label` named `<graph>."<label>"`.
SELECT * FROM ag_catalog.create_vlabel('docs_graph', 'Document');
SELECT * FROM ag_catalog.create_vlabel('docs_graph', 'Person');
SELECT * FROM ag_catalog.create_vlabel('docs_graph', 'Organization');
SELECT * FROM ag_catalog.create_vlabel('docs_graph', 'Concept');
SELECT * FROM ag_catalog.create_vlabel('docs_graph', 'Location');
SELECT * FROM ag_catalog.create_vlabel('docs_graph', 'Topic');

-- Edge labels (relationship types). Each `create_elabel` call materializes
-- a backing edge table under `ag_label` named `<graph>."<label>"`.
SELECT * FROM ag_catalog.create_elabel('docs_graph', 'MENTIONS');
SELECT * FROM ag_catalog.create_elabel('docs_graph', 'REFERENCES');
SELECT * FROM ag_catalog.create_elabel('docs_graph', 'BELONGS_TO');
SELECT * FROM ag_catalog.create_elabel('docs_graph', 'RELATED_TO');
SELECT * FROM ag_catalog.create_elabel('docs_graph', 'AUTHORED_BY');
