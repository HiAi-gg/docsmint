CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.metadata_reembed_outbox (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  workspace_id text,
  revision text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS metadata_reembed_outbox_operation_document_idx
  ON public.metadata_reembed_outbox (operation_id, document_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS metadata_reembed_outbox_operation_id_idx
  ON public.metadata_reembed_outbox (operation_id, id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS metadata_reembed_outbox_created_id_idx
  ON public.metadata_reembed_outbox (created_at, id);--> statement-breakpoint

ALTER TABLE public.metadata_reembed_outbox ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.metadata_reembed_outbox FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.metadata_reembed_outbox;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.metadata_reembed_outbox
  FOR ALL TO hiai_app
  USING (
    current_setting('app.current_user_role', true) = 'admin'
    OR EXISTS (
      SELECT 1
      FROM public.documents AS parent
      WHERE parent.id = metadata_reembed_outbox.document_id
        AND parent.owner_id = metadata_reembed_outbox.owner_id
        AND parent.workspace_id IS NOT DISTINCT FROM metadata_reembed_outbox.workspace_id
        AND (
          (parent.workspace_id IS NULL
            AND parent.owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
          OR (parent.workspace_id IS NOT NULL
            AND parent.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), ''))
        )
    )
  )
  WITH CHECK (
    current_setting('app.current_user_role', true) = 'admin'
    OR EXISTS (
      SELECT 1
      FROM public.documents AS parent
      WHERE parent.id = metadata_reembed_outbox.document_id
        AND parent.owner_id = metadata_reembed_outbox.owner_id
        AND parent.workspace_id IS NOT DISTINCT FROM metadata_reembed_outbox.workspace_id
        AND (
          (parent.workspace_id IS NULL
            AND parent.owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
          OR (parent.workspace_id IS NOT NULL
            AND parent.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), ''))
        )
    )
  );--> statement-breakpoint

-- Child rows inherit their tenant from the parent document. The stored
-- workspace must match the parent, so a caller cannot smuggle a child row
-- across a personal/workspace boundary even when it knows both UUIDs.
DROP POLICY IF EXISTS tenant_isolation ON public.attachments;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.attachments
  FOR ALL TO hiai_app
  USING (
    current_setting('app.current_user_role', true) = 'admin'
    OR EXISTS (
      SELECT 1 FROM public.documents AS parent
      WHERE parent.id = attachments.document_id
        AND parent.workspace_id IS NOT DISTINCT FROM attachments.workspace_id
        AND (
          (parent.workspace_id IS NULL
            AND parent.owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
          OR (parent.workspace_id IS NOT NULL
            AND parent.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), ''))
        )
    )
  )
  WITH CHECK (
    current_setting('app.current_user_role', true) = 'admin'
    OR EXISTS (
      SELECT 1 FROM public.documents AS parent
      WHERE parent.id = attachments.document_id
        AND parent.workspace_id IS NOT DISTINCT FROM attachments.workspace_id
        AND (
          (parent.workspace_id IS NULL
            AND parent.owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
          OR (parent.workspace_id IS NOT NULL
            AND parent.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), ''))
        )
    )
  );--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON public.versions;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.versions
  FOR ALL TO hiai_app
  USING (
    current_setting('app.current_user_role', true) = 'admin'
    OR EXISTS (
      SELECT 1 FROM public.documents AS parent
      WHERE parent.id = versions.document_id
        AND parent.workspace_id IS NOT DISTINCT FROM versions.workspace_id
        AND (
          (parent.workspace_id IS NULL
            AND parent.owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
          OR (parent.workspace_id IS NOT NULL
            AND parent.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), ''))
        )
    )
  )
  WITH CHECK (
    current_setting('app.current_user_role', true) = 'admin'
    OR EXISTS (
      SELECT 1 FROM public.documents AS parent
      WHERE parent.id = versions.document_id
        AND parent.workspace_id IS NOT DISTINCT FROM versions.workspace_id
        AND (
          (parent.workspace_id IS NULL
            AND parent.owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
          OR (parent.workspace_id IS NOT NULL
            AND parent.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), ''))
        )
    )
  );--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON public.document_embeddings;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.document_embeddings
  FOR ALL TO hiai_app
  USING (
    current_setting('app.current_user_role', true) = 'admin'
    OR EXISTS (
      SELECT 1 FROM public.documents AS parent
      WHERE parent.id = document_embeddings.document_id
        AND parent.workspace_id IS NOT DISTINCT FROM document_embeddings.workspace_id
        AND (
          (parent.workspace_id IS NULL
            AND parent.owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
          OR (parent.workspace_id IS NOT NULL
            AND parent.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), ''))
        )
    )
  )
  WITH CHECK (
    current_setting('app.current_user_role', true) = 'admin'
    OR EXISTS (
      SELECT 1 FROM public.documents AS parent
      WHERE parent.id = document_embeddings.document_id
        AND parent.workspace_id IS NOT DISTINCT FROM document_embeddings.workspace_id
        AND (
          (parent.workspace_id IS NULL
            AND parent.owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
          OR (parent.workspace_id IS NOT NULL
            AND parent.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), ''))
        )
    )
  );--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON public.document_tags;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.document_tags
  FOR ALL TO hiai_app
  USING (
    current_setting('app.current_user_role', true) = 'admin'
    OR EXISTS (
      SELECT 1
      FROM public.documents AS parent
      JOIN public.tags AS tag_parent ON tag_parent.id = document_tags.tag_id
      WHERE parent.id = document_tags.document_id
        AND parent.workspace_id IS NOT DISTINCT FROM document_tags.workspace_id
        AND tag_parent.workspace_id IS NOT DISTINCT FROM document_tags.workspace_id
        AND (
          (parent.workspace_id IS NULL
            AND parent.owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
            AND tag_parent.owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
          OR (parent.workspace_id IS NOT NULL
            AND parent.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), ''))
        )
    )
  )
  WITH CHECK (
    current_setting('app.current_user_role', true) = 'admin'
    OR EXISTS (
      SELECT 1
      FROM public.documents AS parent
      JOIN public.tags AS tag_parent ON tag_parent.id = document_tags.tag_id
      WHERE parent.id = document_tags.document_id
        AND parent.workspace_id IS NOT DISTINCT FROM document_tags.workspace_id
        AND tag_parent.workspace_id IS NOT DISTINCT FROM document_tags.workspace_id
        AND (
          (parent.workspace_id IS NULL
            AND parent.owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
            AND tag_parent.owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
          OR (parent.workspace_id IS NOT NULL
            AND parent.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), ''))
        )
    )
  );--> statement-breakpoint

-- The 0035 batch WITH CHECK compared nullable workspace ids with `=`, which
-- rejected valid personal batches. Derive both visibility and writes from the
-- parent run and require an exact nullable workspace match.
DROP POLICY IF EXISTS pipeline_tenant_isolation ON public.document_pipeline_batches;--> statement-breakpoint
CREATE POLICY pipeline_tenant_isolation ON public.document_pipeline_batches
  FOR ALL TO hiai_app
  USING (
    current_setting('app.current_user_role', true) = 'admin'
    OR EXISTS (
      SELECT 1 FROM public.document_pipeline_runs AS pipeline_parent
      WHERE pipeline_parent.generation_id = document_pipeline_batches.generation_id
        AND pipeline_parent.document_id = document_pipeline_batches.document_id
        AND pipeline_parent.workspace_id IS NOT DISTINCT FROM document_pipeline_batches.workspace_id
        AND (
          (pipeline_parent.workspace_id IS NULL
            AND pipeline_parent.owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
          OR (pipeline_parent.workspace_id IS NOT NULL
            AND pipeline_parent.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), ''))
        )
    )
  )
  WITH CHECK (
    current_setting('app.current_user_role', true) = 'admin'
    OR EXISTS (
      SELECT 1 FROM public.document_pipeline_runs AS pipeline_parent
      WHERE pipeline_parent.generation_id = document_pipeline_batches.generation_id
        AND pipeline_parent.document_id = document_pipeline_batches.document_id
        AND pipeline_parent.workspace_id IS NOT DISTINCT FROM document_pipeline_batches.workspace_id
        AND (
          (pipeline_parent.workspace_id IS NULL
            AND pipeline_parent.owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
          OR (pipeline_parent.workspace_id IS NOT NULL
            AND pipeline_parent.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), ''))
        )
    )
  );--> statement-breakpoint

ALTER TABLE public.document_tags FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.attachments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.versions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.document_embeddings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.document_pipeline_batches FORCE ROW LEVEL SECURITY;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.metadata_reembed_outbox TO hiai_app;
