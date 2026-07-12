-- AGE may leave the migration session search_path with ag_catalog first.
-- Preserve any already-created pipeline data by moving the exact relations and
-- enum types into public only when the public target does not already exist.
DO $$
BEGIN
  IF to_regclass('public.document_pipeline_runs') IS NULL
     AND to_regclass('ag_catalog.document_pipeline_runs') IS NOT NULL THEN
    ALTER TABLE ag_catalog.document_pipeline_runs SET SCHEMA public;
  END IF;
  IF to_regclass('public.document_pipeline_batches') IS NULL
     AND to_regclass('ag_catalog.document_pipeline_batches') IS NOT NULL THEN
    ALTER TABLE ag_catalog.document_pipeline_batches SET SCHEMA public;
  END IF;
END $$;--> statement-breakpoint

DO $$
BEGIN
  IF to_regtype('public.pipeline_stage') IS NULL
     AND to_regtype('ag_catalog.pipeline_stage') IS NOT NULL THEN
    ALTER TYPE ag_catalog.pipeline_stage SET SCHEMA public;
  END IF;
  IF to_regtype('public.pipeline_status') IS NULL
     AND to_regtype('ag_catalog.pipeline_status') IS NOT NULL THEN
    ALTER TYPE ag_catalog.pipeline_status SET SCHEMA public;
  END IF;
END $$;--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.document_pipeline_runs') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.document_pipeline_runs TO hiai_app;
  END IF;
  IF to_regclass('public.document_pipeline_batches') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.document_pipeline_batches TO hiai_app;
  END IF;
END $$;--> statement-breakpoint

ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hiai_app;
