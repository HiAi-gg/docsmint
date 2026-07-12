-- Canonical GraphRAG DDL for the single PostgreSQL instance.
-- PostgreSQL bootstrap installs AGE; this migration owns the graph, labels,
-- indexes, and runtime-role grants. Keep string arguments as SQL literals:
-- AGE exposes create_vlabel/create_elabel with cstring parameters, and a
-- PL/pgSQL text variable does not implicitly cast to cstring on a clean DB.
LOAD 'age';--> statement-breakpoint
SET search_path = ag_catalog, public;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_graph WHERE name = 'docs_graph') THEN
    PERFORM ag_catalog.create_graph('docs_graph');
  END IF;
END
$$;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_label l JOIN ag_catalog.ag_graph g ON g.graphid = l.graph WHERE g.name = 'docs_graph' AND l.name = 'Document' AND l.kind = 'v') THEN PERFORM ag_catalog.create_vlabel('docs_graph', 'Document'); END IF;
  IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_label l JOIN ag_catalog.ag_graph g ON g.graphid = l.graph WHERE g.name = 'docs_graph' AND l.name = 'Person' AND l.kind = 'v') THEN PERFORM ag_catalog.create_vlabel('docs_graph', 'Person'); END IF;
  IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_label l JOIN ag_catalog.ag_graph g ON g.graphid = l.graph WHERE g.name = 'docs_graph' AND l.name = 'Organization' AND l.kind = 'v') THEN PERFORM ag_catalog.create_vlabel('docs_graph', 'Organization'); END IF;
  IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_label l JOIN ag_catalog.ag_graph g ON g.graphid = l.graph WHERE g.name = 'docs_graph' AND l.name = 'Concept' AND l.kind = 'v') THEN PERFORM ag_catalog.create_vlabel('docs_graph', 'Concept'); END IF;
  IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_label l JOIN ag_catalog.ag_graph g ON g.graphid = l.graph WHERE g.name = 'docs_graph' AND l.name = 'Location' AND l.kind = 'v') THEN PERFORM ag_catalog.create_vlabel('docs_graph', 'Location'); END IF;
  IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_label l JOIN ag_catalog.ag_graph g ON g.graphid = l.graph WHERE g.name = 'docs_graph' AND l.name = 'Topic' AND l.kind = 'v') THEN PERFORM ag_catalog.create_vlabel('docs_graph', 'Topic'); END IF;

  IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_label l JOIN ag_catalog.ag_graph g ON g.graphid = l.graph WHERE g.name = 'docs_graph' AND l.name = 'MENTIONS' AND l.kind = 'e') THEN PERFORM ag_catalog.create_elabel('docs_graph', 'MENTIONS'); END IF;
  IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_label l JOIN ag_catalog.ag_graph g ON g.graphid = l.graph WHERE g.name = 'docs_graph' AND l.name = 'REFERENCES' AND l.kind = 'e') THEN PERFORM ag_catalog.create_elabel('docs_graph', 'REFERENCES'); END IF;
  IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_label l JOIN ag_catalog.ag_graph g ON g.graphid = l.graph WHERE g.name = 'docs_graph' AND l.name = 'BELONGS_TO' AND l.kind = 'e') THEN PERFORM ag_catalog.create_elabel('docs_graph', 'BELONGS_TO'); END IF;
  IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_label l JOIN ag_catalog.ag_graph g ON g.graphid = l.graph WHERE g.name = 'docs_graph' AND l.name = 'RELATED_TO' AND l.kind = 'e') THEN PERFORM ag_catalog.create_elabel('docs_graph', 'RELATED_TO'); END IF;
  IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_label l JOIN ag_catalog.ag_graph g ON g.graphid = l.graph WHERE g.name = 'docs_graph' AND l.name = 'AUTHORED_BY' AND l.kind = 'e') THEN PERFORM ag_catalog.create_elabel('docs_graph', 'AUTHORED_BY'); END IF;
END
$$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_document_properties ON docs_graph."Document" USING gin (properties);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_person_properties ON docs_graph."Person" USING gin (properties);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_organization_properties ON docs_graph."Organization" USING gin (properties);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_concept_properties ON docs_graph."Concept" USING gin (properties);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_location_properties ON docs_graph."Location" USING gin (properties);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_topic_properties ON docs_graph."Topic" USING gin (properties);--> statement-breakpoint

GRANT USAGE ON SCHEMA docs_graph TO hiai_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA docs_graph TO hiai_app;--> statement-breakpoint
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA docs_graph TO hiai_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA docs_graph GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hiai_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA docs_graph GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO hiai_app;
