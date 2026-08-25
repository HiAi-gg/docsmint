-- A subject advisory lock is the common serialization point even before any
-- lifecycle row exists. User-row locks are unsafe here: guarded child inserts
-- already hold FK key-share locks, so upgrading multiple owners after the
-- statement can deadlock despite a sorted loop.
CREATE OR REPLACE FUNCTION public.acquire_account_purge_fence_lock(subject_user_id uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'docsmint:account-purge-fence:v1:' || subject_user_id::text,
      0
    )
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.acquire_account_purge_fence_lock(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.acquire_account_purge_fence_lock(uuid) TO hiai_app;--> statement-breakpoint

-- Lifecycle cleanup is authorized only for the exact running, fenced purge
-- operation and its unguessable lease owner. Callers cannot enable a generic
-- bypass by setting a boolean GUC.
CREATE OR REPLACE FUNCTION public.lifecycle_cleanup_authorized(subject_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.lifecycle_operations AS operation
    WHERE operation.id = NULLIF(current_setting('app.lifecycle_operation_id', true), '')::uuid
      AND operation.lease_owner = NULLIF(current_setting('app.lifecycle_lease_owner', true), '')
      AND operation.actor_user_id = subject_user_id
      AND operation.operation_kind = 'purge'
      AND operation.status = 'running'
      AND operation.fence_token_hash IS NOT NULL
      AND operation.lease_expires_at > now()
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.lifecycle_cleanup_authorized(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.lifecycle_cleanup_authorized(uuid) TO hiai_app;--> statement-breakpoint

-- Transition tables let one statement collect all parent and actor subjects,
-- lock parents first in canonical UUID order, then acquire every subject
-- advisory once in UUID order.
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
  candidate_id uuid;
  parent_document_ids uuid[] := ARRAY[]::uuid[];
  parent_folder_ids uuid[] := ARRAY[]::uuid[];
  parent_category_ids uuid[] := ARRAY[]::uuid[];
  parent_share_link_ids uuid[] := ARRAY[]::uuid[];
  subject_user_ids uuid[] := ARRAY[]::uuid[];
  guarded_subject_user_id uuid;
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
    IF subject_kind NOT IN ('parent_document', 'parent_folder', 'parent_category', 'parent_share_link') THEN
      CONTINUE;
    END IF;
    FOREACH transition_relation IN ARRAY transition_relations LOOP
      FOR candidate_id IN EXECUTE format(
        'SELECT DISTINCT NULLIF(to_jsonb(row_data)->>%L, '''')::uuid
           FROM %I AS row_data
          WHERE NULLIF(to_jsonb(row_data)->>%L, '''') IS NOT NULL
          ORDER BY 1',
        subject_column,
        transition_relation,
        subject_column
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

  -- FOR SHARE blocks a concurrent owner transfer before owner resolution.
  FOR guarded_subject_user_id IN
    SELECT parent.owner_id FROM public.documents AS parent
    WHERE parent.id = ANY(parent_document_ids)
    ORDER BY parent.id FOR SHARE
  LOOP
    subject_user_ids := array_append(subject_user_ids, guarded_subject_user_id);
  END LOOP;
  FOR guarded_subject_user_id IN
    SELECT parent.owner_id FROM public.folders AS parent
    WHERE parent.id = ANY(parent_folder_ids)
    ORDER BY parent.id FOR SHARE
  LOOP
    subject_user_ids := array_append(subject_user_ids, guarded_subject_user_id);
  END LOOP;
  FOR guarded_subject_user_id IN
    SELECT parent.owner_id FROM public.categories AS parent
    WHERE parent.id = ANY(parent_category_ids)
    ORDER BY parent.id FOR SHARE
  LOOP
    subject_user_ids := array_append(subject_user_ids, guarded_subject_user_id);
  END LOOP;
  FOR guarded_subject_user_id IN
    SELECT parent.created_by FROM public.share_links AS parent
    WHERE parent.id = ANY(parent_share_link_ids)
    ORDER BY parent.id FOR SHARE
  LOOP
    subject_user_ids := array_append(subject_user_ids, guarded_subject_user_id);
  END LOOP;

  FOR argument_index IN 0..TG_NARGS - 1 LOOP
    subject_kind := split_part(TG_ARGV[argument_index], ':', 1);
    subject_column := split_part(TG_ARGV[argument_index], ':', 2);
    IF subject_kind <> 'direct' THEN CONTINUE; END IF;
    FOREACH transition_relation IN ARRAY transition_relations LOOP
      FOR candidate_id IN EXECUTE format(
        'SELECT DISTINCT NULLIF(to_jsonb(row_data)->>%L, '''')::uuid
           FROM %I AS row_data
          WHERE NULLIF(to_jsonb(row_data)->>%L, '''') IS NOT NULL
          ORDER BY 1',
        subject_column,
        transition_relation,
        subject_column
      ) LOOP
        subject_user_ids := array_append(subject_user_ids, candidate_id);
      END LOOP;
    END LOOP;
  END LOOP;

  FOR guarded_subject_user_id IN
    SELECT DISTINCT candidate.subject_user_id
    FROM unnest(subject_user_ids) AS candidate(subject_user_id)
    WHERE candidate.subject_user_id IS NOT NULL
    ORDER BY candidate.subject_user_id
  LOOP
    PERFORM public.acquire_account_purge_fence_lock(guarded_subject_user_id);
    IF NOT public.lifecycle_cleanup_authorized(guarded_subject_user_id)
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

-- Better Auth updates public.users directly. Only the lifecycle's exact,
-- deterministic tombstone is allowed while the verified cleanup token is set.
CREATE OR REPLACE FUNCTION public.enforce_user_account_purge_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  guarded_subject_user_id uuid;
  invalid_tombstone boolean;
BEGIN
  FOR guarded_subject_user_id IN
    SELECT DISTINCT id FROM (
      SELECT id FROM old_rows
      UNION ALL
      SELECT id FROM new_rows
    ) AS changed_users
    ORDER BY id
  LOOP
    PERFORM public.acquire_account_purge_fence_lock(guarded_subject_user_id);
    IF EXISTS (
      SELECT 1 FROM public.lifecycle_operations AS operation
      WHERE operation.actor_user_id = guarded_subject_user_id
        AND operation.operation_kind = 'purge'
        AND operation.fence_token_hash IS NOT NULL
        AND operation.status <> 'rejected'
    ) THEN
      IF NOT public.lifecycle_cleanup_authorized(guarded_subject_user_id) THEN
        RAISE EXCEPTION 'account_purge_fenced'
          USING ERRCODE = '55000', CONSTRAINT = 'account_purge_fenced';
      END IF;
      SELECT EXISTS (
        SELECT 1 FROM new_rows AS updated
        WHERE updated.id = guarded_subject_user_id
          AND (
            updated.email <> 'deleted-' || encode(
              pg_catalog.sha256(
                convert_to('docsmint:privacy-tombstone:v1', 'UTF8')
                  || decode('00', 'hex')
                  || convert_to(updated.id::text, 'UTF8')
              ), 'hex'
            ) || '@invalid.local'
            OR updated.name IS NOT NULL
            OR updated.image IS NOT NULL
            OR updated.email_verified IS DISTINCT FROM false
          )
      ) INTO invalid_tombstone;
      IF invalid_tombstone THEN
        RAISE EXCEPTION 'account_purge_fenced'
          USING ERRCODE = '55000', CONSTRAINT = 'account_purge_fenced';
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.enforce_user_account_purge_fence() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.enforce_user_account_purge_fence() TO hiai_app;--> statement-breakpoint

-- Migration 0023 left ag_catalog first in one historical migration session.
DO $$
BEGIN
  IF to_regclass('public.document_create_operations') IS NOT NULL
    AND to_regclass('ag_catalog.document_create_operations') IS NOT NULL THEN
    RAISE EXCEPTION 'document_create_operations exists in both public and ag_catalog';
  END IF;
  IF to_regclass('public.document_create_operations') IS NULL
    AND to_regclass('ag_catalog.document_create_operations') IS NOT NULL THEN
    ALTER TABLE ag_catalog.document_create_operations SET SCHEMA public;
  END IF;
END;
$$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.document_create_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  workspace_id text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  created_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT document_create_operations_workspace_actor_key_unique UNIQUE(workspace_id, actor_user_id, idempotency_key),
  CONSTRAINT document_create_operations_idempotency_key_check CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS document_create_operations_document_idx ON public.document_create_operations (document_id);--> statement-breakpoint
ALTER TABLE public.document_create_operations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.document_create_operations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS document_create_operations_owner ON public.document_create_operations;--> statement-breakpoint
CREATE POLICY document_create_operations_owner ON public.document_create_operations
  FOR ALL TO hiai_app
  USING (
    actor_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND workspace_id = COALESCE(NULLIF(current_setting('app.current_workspace_id', true), ''), 'personal:' || current_setting('app.current_user_id', true))
  )
  WITH CHECK (
    actor_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND workspace_id = COALESCE(NULLIF(current_setting('app.current_workspace_id', true), ''), 'personal:' || current_setting('app.current_user_id', true))
  );--> statement-breakpoint
GRANT SELECT, INSERT ON public.document_create_operations TO hiai_app;--> statement-breakpoint

-- Remove superseded row-level triggers on upgraded development databases.
DO $$
DECLARE trigger_name text;
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'documents', 'folders', 'tags', 'categories', 'api_keys', 'sessions',
    'accounts', 'share_links', 'document_create_operations',
    'document_pipeline_runs', 'document_knowledge_summaries',
    'document_pipeline_batches', 'metadata_reembed_outbox', 'document_tags',
    'attachments', 'versions', 'document_embeddings', 'guest_access', 'audit_log'
  ] LOOP
    trigger_name := table_name || '_account_purge_fence';
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', trigger_name, table_name);
  END LOOP;
END;
$$;--> statement-breakpoint

-- Event-specific statement triggers are required for transition tables.
-- Pipeline/status cleanup UPDATEs remain allowed; only new work is fenced.
DO $$
DECLARE config record;
DECLARE event_name text;
DECLARE relation_clause text;
DECLARE trigger_arguments text;
BEGIN
  FOR config IN
    SELECT * FROM (VALUES
      ('documents', ARRAY['INSERT','UPDATE','DELETE'], ARRAY['direct:owner_id']),
      ('folders', ARRAY['INSERT','UPDATE','DELETE'], ARRAY['direct:owner_id']),
      ('tags', ARRAY['INSERT','UPDATE','DELETE'], ARRAY['direct:owner_id']),
      ('categories', ARRAY['INSERT','UPDATE','DELETE'], ARRAY['direct:owner_id']),
      ('api_keys', ARRAY['INSERT','UPDATE','DELETE'], ARRAY['direct:owner_id']),
      ('sessions', ARRAY['INSERT','UPDATE','DELETE'], ARRAY['direct:user_id']),
      ('accounts', ARRAY['INSERT','UPDATE','DELETE'], ARRAY['direct:user_id']),
      ('share_links', ARRAY['INSERT','UPDATE','DELETE'], ARRAY['direct:created_by','parent_document:document_id','parent_folder:folder_id','parent_category:category_id']),
      ('document_create_operations', ARRAY['INSERT','UPDATE','DELETE'], ARRAY['direct:actor_user_id','parent_document:document_id']),
      ('document_pipeline_runs', ARRAY['INSERT'], ARRAY['direct:owner_id','parent_document:document_id']),
      ('document_knowledge_summaries', ARRAY['INSERT'], ARRAY['direct:owner_id','parent_document:document_id']),
      ('document_pipeline_batches', ARRAY['INSERT'], ARRAY['parent_document:document_id']),
      ('metadata_reembed_outbox', ARRAY['INSERT'], ARRAY['direct:owner_id','parent_document:document_id']),
      ('document_tags', ARRAY['INSERT','UPDATE','DELETE'], ARRAY['parent_document:document_id']),
      ('attachments', ARRAY['INSERT','UPDATE','DELETE'], ARRAY['parent_document:document_id']),
      ('versions', ARRAY['INSERT','UPDATE','DELETE'], ARRAY['direct:created_by','parent_document:document_id']),
      ('document_embeddings', ARRAY['INSERT'], ARRAY['parent_document:document_id']),
      ('guest_access', ARRAY['INSERT','UPDATE','DELETE'], ARRAY['parent_share_link:share_link_id']),
      ('audit_log', ARRAY['INSERT','UPDATE','DELETE'], ARRAY['direct:actor_id'])
    ) AS entries(table_name, events, arguments)
  LOOP
    SELECT string_agg(quote_literal(argument), ',') INTO trigger_arguments
    FROM unnest(config.arguments) AS argument;
    FOREACH event_name IN ARRAY config.events LOOP
      relation_clause := CASE event_name
        WHEN 'INSERT' THEN 'REFERENCING NEW TABLE AS new_rows'
        WHEN 'UPDATE' THEN 'REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows'
        WHEN 'DELETE' THEN 'REFERENCING OLD TABLE AS old_rows'
      END;
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', config.table_name || '_account_purge_fence_' || lower(event_name), config.table_name);
      EXECUTE format(
        'CREATE TRIGGER %I AFTER %s ON public.%I %s FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_account_purge_fence(%s)',
        config.table_name || '_account_purge_fence_' || lower(event_name), event_name,
        config.table_name, relation_clause, trigger_arguments
      );
    END LOOP;
  END LOOP;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS users_account_purge_fence_update ON public.users;--> statement-breakpoint
CREATE TRIGGER users_account_purge_fence_update
  AFTER UPDATE ON public.users
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_user_account_purge_fence();
