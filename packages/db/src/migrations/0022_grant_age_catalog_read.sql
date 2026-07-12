-- The restricted runtime role reads AGE metadata to verify that docs_graph
-- exists and AGE's cypher planner consults these catalog tables internally.
GRANT SELECT ON ALL TABLES IN SCHEMA ag_catalog TO hiai_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA ag_catalog
  GRANT SELECT ON TABLES TO hiai_app;
