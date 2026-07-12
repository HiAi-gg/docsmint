-- Pipeline tables are created after the original hiai_app privilege bootstrap.
-- Grant existing tables for upgrades/fresh chains and preserve the migration
-- owner's defaults for later public-schema tables.
DO $$
DECLARE
  schema_name text;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['document_pipeline_runs', 'document_pipeline_batches'] LOOP
    schema_name := CASE
      WHEN to_regclass('public.' || table_name) IS NOT NULL THEN 'public'
      WHEN to_regclass('ag_catalog.' || table_name) IS NOT NULL THEN 'ag_catalog'
      ELSE NULL
    END;
    IF schema_name IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO hiai_app',
        schema_name,
        table_name
      );
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hiai_app;
