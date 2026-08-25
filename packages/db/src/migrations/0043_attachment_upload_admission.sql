ALTER TABLE public.attachments
  ADD COLUMN IF NOT EXISTS uploaded_by uuid;--> statement-breakpoint
UPDATE public.attachments AS attachment
SET uploaded_by = parent.owner_id
FROM public.documents AS parent
WHERE parent.id = attachment.document_id
  AND attachment.uploaded_by IS NULL;--> statement-breakpoint
ALTER TABLE public.attachments
  ALTER COLUMN uploaded_by SET NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'attachments_uploaded_by_fkey'
      AND conrelid = 'public.attachments'::regclass
  ) THEN
    ALTER TABLE public.attachments
      ADD CONSTRAINT attachments_uploaded_by_fkey
      FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE RESTRICT;
  END IF;
END;
$$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS attachments_uploaded_by_idx
  ON public.attachments (uploaded_by);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.pending_attachment_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  workspace_id text,
  storage_key text NOT NULL,
  token_hash text NOT NULL,
  filename text NOT NULL,
  mime_type text NOT NULL,
  declared_size bigint NOT NULL,
  quota_reservation_id text,
  confirming_at timestamp,
  expires_at timestamp NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS pending_attachment_uploads_storage_key_unique
  ON public.pending_attachment_uploads (storage_key);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS pending_attachment_uploads_token_hash_unique
  ON public.pending_attachment_uploads (token_hash);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pending_attachment_uploads_actor_expiry_idx
  ON public.pending_attachment_uploads (actor_user_id, expires_at);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pending_attachment_uploads_document_idx
  ON public.pending_attachment_uploads (document_id);--> statement-breakpoint

ALTER TABLE public.pending_attachment_uploads ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.pending_attachment_uploads FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.pending_attachment_uploads;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.pending_attachment_uploads
  FOR ALL TO hiai_app
  USING (
    current_setting('app.current_user_role', true) = 'admin'
    OR actor_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('app.current_user_role', true) = 'admin'
    OR (
      actor_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND EXISTS (
        SELECT 1 FROM public.documents AS parent
        WHERE parent.id = pending_attachment_uploads.document_id
          AND parent.workspace_id IS NOT DISTINCT FROM pending_attachment_uploads.workspace_id
          AND (
            (parent.workspace_id IS NULL AND parent.owner_id = actor_user_id)
            OR (parent.workspace_id IS NOT NULL
              AND parent.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), ''))
          )
      )
    )
  );--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pending_attachment_uploads TO hiai_app;--> statement-breakpoint

-- Account lifecycle must see and remove actor-authored workspace-peer children
-- even when the parent document is owned by another workspace member.
DROP POLICY IF EXISTS tenant_isolation ON public.attachments;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.attachments
  FOR ALL TO hiai_app
  USING (
    current_setting('app.current_user_role', true) = 'admin'
    OR uploaded_by = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    OR EXISTS (
      SELECT 1 FROM public.documents AS parent
      WHERE parent.id = attachments.document_id
        AND parent.workspace_id IS NOT DISTINCT FROM attachments.workspace_id
        AND (
          (parent.workspace_id IS NULL AND parent.owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
          OR (parent.workspace_id IS NOT NULL AND parent.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), ''))
        )
    )
  )
  WITH CHECK (
    current_setting('app.current_user_role', true) = 'admin'
    OR (
      uploaded_by = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND EXISTS (
        SELECT 1 FROM public.documents AS parent
        WHERE parent.id = attachments.document_id
          AND parent.workspace_id IS NOT DISTINCT FROM attachments.workspace_id
          AND (
            (parent.workspace_id IS NULL AND parent.owner_id = uploaded_by)
            OR (parent.workspace_id IS NOT NULL AND parent.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), ''))
          )
      )
    )
  );--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON public.versions;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.versions
  FOR ALL TO hiai_app
  USING (
    current_setting('app.current_user_role', true) = 'admin'
    OR created_by = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    OR EXISTS (
      SELECT 1 FROM public.documents AS parent
      WHERE parent.id = versions.document_id
        AND parent.workspace_id IS NOT DISTINCT FROM versions.workspace_id
        AND (
          (parent.workspace_id IS NULL AND parent.owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
          OR (parent.workspace_id IS NOT NULL AND parent.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), ''))
        )
    )
  )
  WITH CHECK (
    current_setting('app.current_user_role', true) = 'admin'
    OR (
      created_by = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND EXISTS (
        SELECT 1 FROM public.documents AS parent
        WHERE parent.id = versions.document_id
          AND parent.workspace_id IS NOT DISTINCT FROM versions.workspace_id
          AND (
            (parent.workspace_id IS NULL AND parent.owner_id = created_by)
            OR (parent.workspace_id IS NOT NULL AND parent.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), ''))
          )
      )
    )
  );--> statement-breakpoint

-- Replace the pre-column attachment triggers with actor+parent attribution.
DROP TRIGGER IF EXISTS attachments_account_purge_fence_insert ON public.attachments;--> statement-breakpoint
CREATE TRIGGER attachments_account_purge_fence_insert
  AFTER INSERT ON public.attachments
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_account_purge_fence('direct:uploaded_by', 'parent_document:document_id');--> statement-breakpoint
DROP TRIGGER IF EXISTS attachments_account_purge_fence_update ON public.attachments;--> statement-breakpoint
CREATE TRIGGER attachments_account_purge_fence_update
  AFTER UPDATE ON public.attachments
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_account_purge_fence('direct:uploaded_by', 'parent_document:document_id');--> statement-breakpoint
DROP TRIGGER IF EXISTS attachments_account_purge_fence_delete ON public.attachments;--> statement-breakpoint
CREATE TRIGGER attachments_account_purge_fence_delete
  AFTER DELETE ON public.attachments
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_account_purge_fence('direct:uploaded_by', 'parent_document:document_id');--> statement-breakpoint

DROP TRIGGER IF EXISTS pending_attachment_uploads_account_purge_fence_insert ON public.pending_attachment_uploads;--> statement-breakpoint
CREATE TRIGGER pending_attachment_uploads_account_purge_fence_insert
  AFTER INSERT ON public.pending_attachment_uploads
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_account_purge_fence('direct:actor_user_id', 'parent_document:document_id');--> statement-breakpoint

-- Audit attribution is actor-owned. Lifecycle writes the final redacted audit
-- under its verified token after removing prior actor-attributed rows.
DROP TRIGGER IF EXISTS audit_log_account_purge_fence_insert ON public.audit_log;--> statement-breakpoint
CREATE TRIGGER audit_log_account_purge_fence_insert
  AFTER INSERT ON public.audit_log
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_account_purge_fence('direct:actor_id');--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_log_account_purge_fence_update ON public.audit_log;--> statement-breakpoint
CREATE TRIGGER audit_log_account_purge_fence_update
  AFTER UPDATE ON public.audit_log
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_account_purge_fence('direct:actor_id');--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_log_account_purge_fence_delete ON public.audit_log;--> statement-breakpoint
CREATE TRIGGER audit_log_account_purge_fence_delete
  AFTER DELETE ON public.audit_log
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_account_purge_fence('direct:actor_id');
