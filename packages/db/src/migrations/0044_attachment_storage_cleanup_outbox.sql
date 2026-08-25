ALTER TABLE public.pending_attachment_uploads
  ADD COLUMN IF NOT EXISTS quota_operation_key text,
  ADD COLUMN IF NOT EXISTS quota_state text,
  ADD COLUMN IF NOT EXISTS actual_size bigint,
  ADD COLUMN IF NOT EXISTS url_issued_at timestamp,
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamp,
  ADD COLUMN IF NOT EXISTS attempt_count integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS last_error text;--> statement-breakpoint

UPDATE public.pending_attachment_uploads
SET quota_operation_key = 'attachment:' || document_id::text || ':' || storage_key,
    quota_state = CASE
      WHEN quota_reservation_id IS NOT NULL THEN 'reserved'
      ELSE 'not_required'
    END,
    url_issued_at = COALESCE(url_issued_at, created_at)
WHERE quota_operation_key IS NULL OR quota_state IS NULL OR url_issued_at IS NULL;--> statement-breakpoint

ALTER TABLE public.pending_attachment_uploads
  ALTER COLUMN quota_operation_key SET NOT NULL,
  ALTER COLUMN quota_state SET NOT NULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pending_attachment_uploads_quota_state_check'
      AND conrelid = 'public.pending_attachment_uploads'::regclass
  ) THEN
    ALTER TABLE public.pending_attachment_uploads
      ADD CONSTRAINT pending_attachment_uploads_quota_state_check
      CHECK (quota_state IN (
        'not_required', 'reserve_pending', 'reserved',
        'finalize_pending', 'committed'
      ));
  END IF;
END;
$$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS pending_attachment_uploads_cleanup_lease_idx
  ON public.pending_attachment_uploads (expires_at, lease_expires_at, id);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.attachment_storage_cleanup_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  source_kind text NOT NULL,
  source_id uuid NOT NULL,
  storage_key text NOT NULL,
  document_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  requested_by_user_id uuid NOT NULL,
  workspace_id text,
  size bigint NOT NULL,
  quota_operation_key text NOT NULL,
  quota_release_kind text DEFAULT 'none' NOT NULL,
  quota_reservation_id text,
  not_before timestamp DEFAULT now() NOT NULL,
  retain_until timestamp,
  object_deleted_at timestamp,
  lease_owner text,
  lease_expires_at timestamp,
  attempt_count integer DEFAULT 0 NOT NULL,
  last_error text,
  created_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT attachment_storage_cleanup_outbox_source_unique
    UNIQUE (source_kind, source_id),
  CONSTRAINT attachment_storage_cleanup_outbox_storage_key_unique
    UNIQUE (storage_key),
  CONSTRAINT attachment_storage_cleanup_outbox_source_kind_check
    CHECK (source_kind IN ('attachment', 'pending_upload', 'uncommitted_upload')),
  CONSTRAINT attachment_storage_cleanup_outbox_quota_kind_check
    CHECK (quota_release_kind IN (
      'none', 'reserve_pending', 'reservation', 'finalize_pending', 'committed'
    )),
  CONSTRAINT attachment_storage_cleanup_outbox_size_check CHECK (size >= 0),
  CONSTRAINT attachment_storage_cleanup_outbox_reservation_check CHECK (
    quota_release_kind NOT IN ('reservation', 'finalize_pending')
    OR quota_reservation_id IS NOT NULL
  )
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS attachment_storage_cleanup_outbox_ready_idx
  ON public.attachment_storage_cleanup_outbox
  (not_before, lease_expires_at, created_at, id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS attachment_storage_cleanup_outbox_actor_idx
  ON public.attachment_storage_cleanup_outbox (actor_user_id, id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS attachment_storage_cleanup_outbox_owner_idx
  ON public.attachment_storage_cleanup_outbox (owner_user_id, id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS attachment_storage_cleanup_outbox_requester_idx
  ON public.attachment_storage_cleanup_outbox (requested_by_user_id, id);--> statement-breakpoint

ALTER TABLE public.attachment_storage_cleanup_outbox ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.attachment_storage_cleanup_outbox FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.attachment_storage_cleanup_outbox;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.attachment_storage_cleanup_outbox
  FOR ALL TO hiai_app
  USING (
    current_setting('app.current_user_role', true) = 'admin'
    OR (
      requested_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND workspace_id IS NOT DISTINCT FROM NULLIF(current_setting('app.current_workspace_id', true), '')
    )
    OR public.lifecycle_cleanup_authorized(actor_user_id)
    OR public.lifecycle_cleanup_authorized(owner_user_id)
    OR public.lifecycle_cleanup_authorized(requested_by_user_id)
  )
  WITH CHECK (
    current_setting('app.current_user_role', true) = 'admin'
    OR (
      requested_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND workspace_id IS NOT DISTINCT FROM NULLIF(current_setting('app.current_workspace_id', true), '')
    )
    OR public.lifecycle_cleanup_authorized(actor_user_id)
    OR public.lifecycle_cleanup_authorized(owner_user_id)
    OR public.lifecycle_cleanup_authorized(requested_by_user_id)
  );--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.attachment_storage_cleanup_outbox TO hiai_app;--> statement-breakpoint

-- A workspace editor authorized through the parent document must be able to
-- enumerate every pending child before a hard purge. Personal and foreign
-- workspace rows remain isolated, while lifecycle cleanup retains its exact
-- operation-token branch for actor-authored peer uploads.
DROP POLICY IF EXISTS tenant_isolation ON public.pending_attachment_uploads;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.pending_attachment_uploads
  FOR ALL TO hiai_app
  USING (
    current_setting('app.current_user_role', true) = 'admin'
    OR (
      actor_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND (
        (workspace_id IS NULL AND EXISTS (
          SELECT 1 FROM public.documents AS parent
          WHERE parent.id = pending_attachment_uploads.document_id
            AND parent.workspace_id IS NULL
            AND parent.owner_id = actor_user_id
        ))
        OR workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')
        OR public.lifecycle_cleanup_authorized(actor_user_id)
      )
    )
    OR EXISTS (
      SELECT 1 FROM public.documents AS parent
      WHERE parent.id = pending_attachment_uploads.document_id
        AND parent.workspace_id = pending_attachment_uploads.workspace_id
        AND parent.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')
    )
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
            OR parent.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')
          )
      )
    )
    OR public.lifecycle_cleanup_authorized(actor_user_id)
  );--> statement-breakpoint

-- Lifecycle cleanup runs in the departing actor's personal tenant context, so
-- a workspace parent owned by a surviving peer is intentionally hidden by the
-- documents policy. Resolve only the parent of a child authored by the exact
-- verified lifecycle subject, and lock that parent until the child cleanup
-- transaction commits so ownership attribution cannot race the staged intent.
CREATE OR REPLACE FUNCTION public.lifecycle_child_document_owner(
  target_document_id uuid,
  lifecycle_actor_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  resolved_owner_id uuid;
BEGIN
  IF NOT public.lifecycle_cleanup_authorized(lifecycle_actor_id) THEN
    RAISE EXCEPTION 'lifecycle_cleanup_not_authorized'
      USING ERRCODE = '42501';
  END IF;

  SELECT parent.owner_id
  INTO resolved_owner_id
  FROM public.documents AS parent
  WHERE parent.id = target_document_id
    AND (
      (parent.workspace_id IS NULL AND parent.owner_id = lifecycle_actor_id)
      OR EXISTS (
        SELECT 1
        FROM public.attachments AS attachment
        WHERE attachment.document_id = parent.id
          AND attachment.uploaded_by = lifecycle_actor_id
      )
      OR EXISTS (
        SELECT 1
        FROM public.pending_attachment_uploads AS pending
        WHERE pending.document_id = parent.id
          AND pending.actor_user_id = lifecycle_actor_id
      )
    )
  FOR SHARE OF parent;

  IF resolved_owner_id IS NULL THEN
    RAISE EXCEPTION 'lifecycle_child_document_not_authorized'
      USING ERRCODE = '42501';
  END IF;
  RETURN resolved_owner_id;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.lifecycle_child_document_owner(uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.lifecycle_child_document_owner(uuid, uuid) TO hiai_app;--> statement-breakpoint

-- Workspace rows survive an individual account purge. For tenant-owned
-- workspace rows the current request actor, not the historical owner column,
-- is the fenced subject. Personal rows continue to fence their stored owner.
-- During DELETE/cascade cleanup, one exact verified lifecycle token authorizes
-- the whole globally locked statement so an A-owned/B-authored child cannot
-- deadlock two completed purges.
CREATE OR REPLACE FUNCTION public.enforce_account_purge_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  transition_relations text[];
  transition_relation text;
  argument_index integer;
  subject_kind text;
  subject_column text;
  workspace_column text;
  candidate_id uuid;
  parent_document_ids uuid[] := ARRAY[]::uuid[];
  parent_folder_ids uuid[] := ARRAY[]::uuid[];
  parent_category_ids uuid[] := ARRAY[]::uuid[];
  parent_share_link_ids uuid[] := ARRAY[]::uuid[];
  subject_user_ids uuid[] := ARRAY[]::uuid[];
  guarded_subject_user_id uuid;
  current_actor_id uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  cleanup_statement_authorized boolean := false;
BEGIN
  transition_relations := CASE TG_OP
    WHEN 'INSERT' THEN ARRAY['new_rows']
    WHEN 'UPDATE' THEN ARRAY['old_rows', 'new_rows']
    WHEN 'DELETE' THEN ARRAY['old_rows']
    ELSE ARRAY[]::text[]
  END;

  FOR argument_index IN 0..TG_NARGS - 1 LOOP
    subject_kind := split_part(TG_ARGV[argument_index], ':', 1);
    subject_column := split_part(TG_ARGV[argument_index], ':', 2);
    IF subject_kind NOT IN (
      'parent_document', 'parent_folder', 'parent_category', 'parent_share_link'
    ) THEN CONTINUE; END IF;
    FOREACH transition_relation IN ARRAY transition_relations LOOP
      FOR candidate_id IN EXECUTE format(
        'SELECT DISTINCT NULLIF(to_jsonb(row_data)->>%L, '''')::uuid
           FROM %I AS row_data
          WHERE NULLIF(to_jsonb(row_data)->>%L, '''') IS NOT NULL
          ORDER BY 1',
        subject_column, transition_relation, subject_column
      ) LOOP
        IF subject_kind = 'parent_document' THEN
          parent_document_ids := array_append(parent_document_ids, candidate_id);
        ELSIF subject_kind = 'parent_folder' THEN
          parent_folder_ids := array_append(parent_folder_ids, candidate_id);
        ELSIF subject_kind = 'parent_category' THEN
          parent_category_ids := array_append(parent_category_ids, candidate_id);
        ELSE
          parent_share_link_ids := array_append(parent_share_link_ids, candidate_id);
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  FOR guarded_subject_user_id IN
    SELECT CASE WHEN parent.workspace_id IS NULL THEN parent.owner_id ELSE current_actor_id END
    FROM public.documents AS parent
    WHERE parent.id = ANY(parent_document_ids)
    ORDER BY parent.id FOR SHARE
  LOOP
    subject_user_ids := array_append(subject_user_ids, guarded_subject_user_id);
  END LOOP;
  FOR guarded_subject_user_id IN
    SELECT CASE WHEN parent.workspace_id IS NULL THEN parent.owner_id ELSE current_actor_id END
    FROM public.folders AS parent
    WHERE parent.id = ANY(parent_folder_ids)
    ORDER BY parent.id FOR SHARE
  LOOP
    subject_user_ids := array_append(subject_user_ids, guarded_subject_user_id);
  END LOOP;
  FOR guarded_subject_user_id IN
    SELECT CASE WHEN parent.workspace_id IS NULL THEN parent.owner_id ELSE current_actor_id END
    FROM public.categories AS parent
    WHERE parent.id = ANY(parent_category_ids)
    ORDER BY parent.id FOR SHARE
  LOOP
    subject_user_ids := array_append(subject_user_ids, guarded_subject_user_id);
  END LOOP;
  FOR guarded_subject_user_id IN
    SELECT CASE WHEN parent.workspace_id IS NULL THEN parent.created_by ELSE current_actor_id END
    FROM public.share_links AS parent
    WHERE parent.id = ANY(parent_share_link_ids)
    ORDER BY parent.id FOR SHARE
  LOOP
    subject_user_ids := array_append(subject_user_ids, guarded_subject_user_id);
  END LOOP;

  FOR argument_index IN 0..TG_NARGS - 1 LOOP
    subject_kind := split_part(TG_ARGV[argument_index], ':', 1);
    subject_column := split_part(TG_ARGV[argument_index], ':', 2);
    workspace_column := split_part(TG_ARGV[argument_index], ':', 3);
    IF subject_kind NOT IN ('direct', 'tenant_owner') THEN CONTINUE; END IF;
    FOREACH transition_relation IN ARRAY transition_relations LOOP
      IF subject_kind = 'tenant_owner' THEN
        FOR candidate_id IN EXECUTE format(
          'SELECT DISTINCT CASE
             WHEN NULLIF(to_jsonb(row_data)->>%L, '''') IS NULL
               THEN NULLIF(to_jsonb(row_data)->>%L, '''')::uuid
             ELSE $1
           END
           FROM %I AS row_data
          WHERE NULLIF(to_jsonb(row_data)->>%L, '''') IS NOT NULL
          ORDER BY 1',
          workspace_column, subject_column, transition_relation, subject_column
        ) USING current_actor_id LOOP
          subject_user_ids := array_append(subject_user_ids, candidate_id);
        END LOOP;
      ELSE
        FOR candidate_id IN EXECUTE format(
          'SELECT DISTINCT NULLIF(to_jsonb(row_data)->>%L, '''')::uuid
             FROM %I AS row_data
            WHERE NULLIF(to_jsonb(row_data)->>%L, '''') IS NOT NULL
            ORDER BY 1',
          subject_column, transition_relation, subject_column
        ) LOOP
          subject_user_ids := array_append(subject_user_ids, candidate_id);
        END LOOP;
      END IF;
    END LOOP;
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    SELECT EXISTS (
      SELECT 1 FROM (
        SELECT DISTINCT candidate.subject_user_id
        FROM unnest(subject_user_ids) AS candidate(subject_user_id)
        WHERE candidate.subject_user_id IS NOT NULL
      ) AS subjects
      WHERE public.lifecycle_cleanup_authorized(subjects.subject_user_id)
    ) INTO cleanup_statement_authorized;
  END IF;

  FOR guarded_subject_user_id IN
    SELECT DISTINCT candidate.subject_user_id
    FROM unnest(subject_user_ids) AS candidate(subject_user_id)
    WHERE candidate.subject_user_id IS NOT NULL
    ORDER BY candidate.subject_user_id
  LOOP
    PERFORM public.acquire_account_purge_fence_lock(guarded_subject_user_id);
    IF NOT cleanup_statement_authorized
      AND NOT public.lifecycle_cleanup_authorized(guarded_subject_user_id)
      AND EXISTS (
        SELECT 1 FROM public.lifecycle_operations AS operation
        WHERE operation.actor_user_id = guarded_subject_user_id
          AND operation.operation_kind = 'purge'
          AND operation.fence_token_hash IS NOT NULL
          AND operation.status <> 'rejected'
      ) THEN
      RAISE EXCEPTION 'account_purge_fenced'
        USING ERRCODE = '55000', CONSTRAINT = 'account_purge_fenced';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.enforce_account_purge_fence() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.enforce_account_purge_fence() TO hiai_app;--> statement-breakpoint

DO $$
DECLARE table_name text;
DECLARE event_name text;
DECLARE relation_clause text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['documents', 'folders', 'tags', 'categories'] LOOP
    FOREACH event_name IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
      relation_clause := CASE event_name
        WHEN 'INSERT' THEN 'REFERENCING NEW TABLE AS new_rows'
        WHEN 'UPDATE' THEN 'REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows'
        WHEN 'DELETE' THEN 'REFERENCING OLD TABLE AS old_rows'
      END;
      EXECUTE format(
        'DROP TRIGGER IF EXISTS %I ON public.%I',
        table_name || '_account_purge_fence_' || lower(event_name), table_name
      );
      EXECUTE format(
        'CREATE TRIGGER %I AFTER %s ON public.%I %s FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_account_purge_fence(''tenant_owner:owner_id:workspace_id'')',
        table_name || '_account_purge_fence_' || lower(event_name), event_name,
        table_name, relation_clause
      );
    END LOOP;
  END LOOP;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS pending_attachment_uploads_account_purge_fence_update
  ON public.pending_attachment_uploads;--> statement-breakpoint
CREATE TRIGGER pending_attachment_uploads_account_purge_fence_update
  AFTER UPDATE ON public.pending_attachment_uploads
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_account_purge_fence(
    'direct:actor_user_id', 'parent_document:document_id'
  );--> statement-breakpoint
DROP TRIGGER IF EXISTS pending_attachment_uploads_account_purge_fence_delete
  ON public.pending_attachment_uploads;--> statement-breakpoint
CREATE TRIGGER pending_attachment_uploads_account_purge_fence_delete
  AFTER DELETE ON public.pending_attachment_uploads
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_account_purge_fence(
    'direct:actor_user_id', 'parent_document:document_id'
  );--> statement-breakpoint

DROP TRIGGER IF EXISTS attachment_storage_cleanup_outbox_account_purge_fence_insert
  ON public.attachment_storage_cleanup_outbox;--> statement-breakpoint
CREATE TRIGGER attachment_storage_cleanup_outbox_account_purge_fence_insert
  AFTER INSERT ON public.attachment_storage_cleanup_outbox
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_account_purge_fence(
    'direct:requested_by_user_id'
  );
