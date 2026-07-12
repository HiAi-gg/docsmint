-- Enforce tenant isolation on durable BullMQ pipeline state.
--
-- Runs carry their owner directly. Batches deliberately derive ownership from
-- the matching parent run so a caller cannot gain access by supplying only a
-- document or generation identifier from another tenant.

ALTER TABLE public.document_pipeline_runs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.document_pipeline_runs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.document_pipeline_batches ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.document_pipeline_batches FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS pipeline_tenant_isolation ON public.document_pipeline_runs;--> statement-breakpoint
CREATE POLICY pipeline_tenant_isolation ON public.document_pipeline_runs
  FOR ALL TO hiai_app
  USING (
    owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    OR current_setting('app.current_user_role', true) = 'admin'
  )
  WITH CHECK (
    owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    OR current_setting('app.current_user_role', true) = 'admin'
  );--> statement-breakpoint

DROP POLICY IF EXISTS pipeline_tenant_isolation ON public.document_pipeline_batches;--> statement-breakpoint
CREATE POLICY pipeline_tenant_isolation ON public.document_pipeline_batches
  FOR ALL TO hiai_app
  USING (
    current_setting('app.current_user_role', true) = 'admin'
    OR EXISTS (
      SELECT 1
      FROM public.document_pipeline_runs AS pipeline_parent
      WHERE pipeline_parent.generation_id = document_pipeline_batches.generation_id
        AND pipeline_parent.document_id = document_pipeline_batches.document_id
        AND pipeline_parent.owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    current_setting('app.current_user_role', true) = 'admin'
    OR EXISTS (
      SELECT 1
      FROM public.document_pipeline_runs AS pipeline_parent
      WHERE pipeline_parent.generation_id = document_pipeline_batches.generation_id
        AND pipeline_parent.document_id = document_pipeline_batches.document_id
        AND pipeline_parent.owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    )
  );--> statement-breakpoint

-- FORCE RLS also applies to a non-superuser table owner. Keep the dedicated
-- migration owner usable for maintenance without granting BYPASSRLS to the
-- application role. The migration command rejects hiai_app as its owner URL.
DO $$
BEGIN
  IF current_user = 'hiai_app' THEN
    RAISE EXCEPTION 'pipeline RLS migration must run as the migration owner, not hiai_app';
  END IF;

  EXECUTE 'DROP POLICY IF EXISTS pipeline_migration_owner_access ON public.document_pipeline_runs';
  EXECUTE format(
    'CREATE POLICY pipeline_migration_owner_access ON public.document_pipeline_runs FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
  EXECUTE 'DROP POLICY IF EXISTS pipeline_migration_owner_access ON public.document_pipeline_batches';
  EXECUTE format(
    'CREATE POLICY pipeline_migration_owner_access ON public.document_pipeline_batches FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END $$;
