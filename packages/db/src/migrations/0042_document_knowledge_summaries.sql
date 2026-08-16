CREATE TABLE IF NOT EXISTS public.document_knowledge_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  workspace_id text DEFAULT NULLIF(current_setting('app.current_workspace_id', true), ''),
  generation_id uuid NOT NULL,
  revision text NOT NULL,
  language text NOT NULL,
  description text NOT NULL,
  keywords text[] DEFAULT ARRAY[]::text[] NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT document_knowledge_summaries_document_generation_unique
    UNIQUE (document_id, generation_id)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS document_knowledge_summaries_owner_document_idx
  ON public.document_knowledge_summaries (owner_id, document_id);--> statement-breakpoint

ALTER TABLE public.document_knowledge_summaries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.document_knowledge_summaries FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS knowledge_summary_tenant_isolation
  ON public.document_knowledge_summaries;--> statement-breakpoint
CREATE POLICY knowledge_summary_tenant_isolation
  ON public.document_knowledge_summaries
  FOR ALL TO hiai_app
  USING (
    current_setting('app.current_user_role', true) = 'admin'
    OR (
      workspace_id IS NULL
      AND owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    )
    OR (
      workspace_id IS NOT NULL
      AND workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')
    )
  )
  WITH CHECK (
    current_setting('app.current_user_role', true) = 'admin'
    OR (
      workspace_id IS NULL
      AND owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    )
    OR (
      workspace_id IS NOT NULL
      AND workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')
    )
  );--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_knowledge_summaries TO hiai_app;--> statement-breakpoint

DO $$
BEGIN
  IF current_user = 'hiai_app' THEN
    RAISE EXCEPTION 'knowledge summary migration must run as the migration owner, not hiai_app';
  END IF;
  EXECUTE 'DROP POLICY IF EXISTS knowledge_summary_migration_owner_access ON public.document_knowledge_summaries';
  EXECUTE format(
    'CREATE POLICY knowledge_summary_migration_owner_access ON public.document_knowledge_summaries FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END $$;
