-- Pipeline tables are created after the original hiai_app privilege bootstrap.
-- Grant existing tables for upgrades/fresh chains and preserve the migration
-- owner's defaults for later public-schema tables.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.document_pipeline_runs, public.document_pipeline_batches
  TO hiai_app;--> statement-breakpoint

ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hiai_app;
