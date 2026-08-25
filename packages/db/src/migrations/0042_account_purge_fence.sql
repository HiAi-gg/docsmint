-- Every account-owned write and the lifecycle fence establishment serialize
-- on the same durable user row. This closes both sides of the race: a write
-- that got there first commits before the fence snapshot, while a write that
-- got there second observes the committed fence and is rejected.
CREATE OR REPLACE FUNCTION public.enforce_account_purge_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  new_subject_user_id uuid;
  old_subject_user_id uuid;
  guarded_subject_user_id uuid;
  fenced_operation record;
BEGIN
  IF TG_OP NOT IN ('INSERT', 'UPDATE') THEN
    RETURN NEW;
  END IF;

  CASE TG_ARGV[0]
    WHEN 'owner_id' THEN
      new_subject_user_id := NULLIF(to_jsonb(NEW)->>'owner_id', '')::uuid;
    WHEN 'user_id' THEN
      new_subject_user_id := NULLIF(to_jsonb(NEW)->>'user_id', '')::uuid;
    WHEN 'actor_user_id' THEN
      new_subject_user_id := NULLIF(to_jsonb(NEW)->>'actor_user_id', '')::uuid;
    WHEN 'created_by' THEN
      new_subject_user_id := NULLIF(to_jsonb(NEW)->>'created_by', '')::uuid;
    WHEN 'document_id' THEN
      SELECT parent.owner_id
      INTO new_subject_user_id
      FROM public.documents AS parent
      WHERE parent.id = NULLIF(to_jsonb(NEW)->>'document_id', '')::uuid;
    ELSE
      RAISE EXCEPTION 'unsupported account purge fence subject'
        USING ERRCODE = '22023';
  END CASE;

  IF TG_OP = 'UPDATE' THEN
    CASE TG_ARGV[0]
      WHEN 'owner_id' THEN
        old_subject_user_id := NULLIF(to_jsonb(OLD)->>'owner_id', '')::uuid;
      WHEN 'user_id' THEN
        old_subject_user_id := NULLIF(to_jsonb(OLD)->>'user_id', '')::uuid;
      WHEN 'actor_user_id' THEN
        old_subject_user_id := NULLIF(to_jsonb(OLD)->>'actor_user_id', '')::uuid;
      WHEN 'created_by' THEN
        old_subject_user_id := NULLIF(to_jsonb(OLD)->>'created_by', '')::uuid;
      WHEN 'document_id' THEN
        SELECT parent.owner_id
        INTO old_subject_user_id
        FROM public.documents AS parent
        WHERE parent.id = NULLIF(to_jsonb(OLD)->>'document_id', '')::uuid;
    END CASE;
  END IF;

  FOR guarded_subject_user_id IN
    SELECT DISTINCT candidate.subject_user_id
    FROM unnest(ARRAY[new_subject_user_id, old_subject_user_id])
      AS candidate(subject_user_id)
    WHERE candidate.subject_user_id IS NOT NULL
    ORDER BY candidate.subject_user_id
  LOOP
    -- This exact row lock is also taken before the lifecycle service records
    -- fence_token_hash. It remains a serialization point even if no operation
    -- row existed when the guarded write began. Sorting also makes ownership
    -- transfers collision-safe across concurrent transactions.
    PERFORM account.id
    FROM public.users AS account
    WHERE account.id = guarded_subject_user_id
    FOR UPDATE;

    FOR fenced_operation IN
      SELECT operation.id
      FROM public.lifecycle_operations AS operation
      WHERE operation.actor_user_id = guarded_subject_user_id
        AND operation.operation_kind = 'purge'
        AND operation.fence_token_hash IS NOT NULL
        AND operation.status <> 'rejected'
      ORDER BY operation.id
      FOR UPDATE
    LOOP
      RAISE EXCEPTION 'account_purge_fenced'
        USING
          ERRCODE = '55000',
          CONSTRAINT = 'account_purge_fenced';
    END LOOP;
  END LOOP;

  RETURN NEW;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.enforce_account_purge_fence() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.enforce_account_purge_fence() TO hiai_app;--> statement-breakpoint

-- Migration 0023 initialized AGE on the same connection and left ag_catalog
-- first in its session search_path. Historical 0037 therefore created this
-- unqualified table in ag_catalog even though the journal recorded success.
-- Repair both existing upgrades and fresh installs before attaching the fence.
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
  CONSTRAINT document_create_operations_workspace_actor_key_unique
    UNIQUE(workspace_id, actor_user_id, idempotency_key),
  CONSTRAINT document_create_operations_idempotency_key_check
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS document_create_operations_document_idx
  ON public.document_create_operations (document_id);--> statement-breakpoint
ALTER TABLE public.document_create_operations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.document_create_operations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS document_create_operations_owner
  ON public.document_create_operations;--> statement-breakpoint
CREATE POLICY document_create_operations_owner ON public.document_create_operations
  FOR ALL TO hiai_app
  USING (
    actor_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND workspace_id = COALESCE(
      NULLIF(current_setting('app.current_workspace_id', true), ''),
      'personal:' || current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    actor_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND workspace_id = COALESCE(
      NULLIF(current_setting('app.current_workspace_id', true), ''),
      'personal:' || current_setting('app.current_user_id', true)
    )
  );--> statement-breakpoint
GRANT SELECT, INSERT ON public.document_create_operations TO hiai_app;--> statement-breakpoint

DROP TRIGGER IF EXISTS documents_account_purge_fence ON public.documents;--> statement-breakpoint
CREATE TRIGGER documents_account_purge_fence
  BEFORE INSERT OR UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_purge_fence('owner_id');--> statement-breakpoint

DROP TRIGGER IF EXISTS folders_account_purge_fence ON public.folders;--> statement-breakpoint
CREATE TRIGGER folders_account_purge_fence
  BEFORE INSERT OR UPDATE ON public.folders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_purge_fence('owner_id');--> statement-breakpoint

DROP TRIGGER IF EXISTS tags_account_purge_fence ON public.tags;--> statement-breakpoint
CREATE TRIGGER tags_account_purge_fence
  BEFORE INSERT OR UPDATE ON public.tags
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_purge_fence('owner_id');--> statement-breakpoint

DROP TRIGGER IF EXISTS categories_account_purge_fence ON public.categories;--> statement-breakpoint
CREATE TRIGGER categories_account_purge_fence
  BEFORE INSERT OR UPDATE ON public.categories
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_purge_fence('owner_id');--> statement-breakpoint

DROP TRIGGER IF EXISTS api_keys_account_purge_fence ON public.api_keys;--> statement-breakpoint
CREATE TRIGGER api_keys_account_purge_fence
  BEFORE INSERT OR UPDATE ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_purge_fence('owner_id');--> statement-breakpoint

DROP TRIGGER IF EXISTS sessions_account_purge_fence ON public.sessions;--> statement-breakpoint
CREATE TRIGGER sessions_account_purge_fence
  BEFORE INSERT OR UPDATE ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_purge_fence('user_id');--> statement-breakpoint

DROP TRIGGER IF EXISTS accounts_account_purge_fence ON public.accounts;--> statement-breakpoint
CREATE TRIGGER accounts_account_purge_fence
  BEFORE INSERT OR UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_purge_fence('user_id');--> statement-breakpoint

DROP TRIGGER IF EXISTS share_links_account_purge_fence ON public.share_links;--> statement-breakpoint
CREATE TRIGGER share_links_account_purge_fence
  BEFORE INSERT OR UPDATE ON public.share_links
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_purge_fence('created_by');--> statement-breakpoint

DROP TRIGGER IF EXISTS document_create_operations_account_purge_fence
  ON public.document_create_operations;--> statement-breakpoint
CREATE TRIGGER document_create_operations_account_purge_fence
  BEFORE INSERT OR UPDATE ON public.document_create_operations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_purge_fence('actor_user_id');--> statement-breakpoint

DROP TRIGGER IF EXISTS document_pipeline_runs_account_purge_fence ON public.document_pipeline_runs;--> statement-breakpoint
CREATE TRIGGER document_pipeline_runs_account_purge_fence
  BEFORE INSERT OR UPDATE ON public.document_pipeline_runs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_purge_fence('owner_id');--> statement-breakpoint

DROP TRIGGER IF EXISTS document_knowledge_summaries_account_purge_fence ON public.document_knowledge_summaries;--> statement-breakpoint
CREATE TRIGGER document_knowledge_summaries_account_purge_fence
  BEFORE INSERT OR UPDATE ON public.document_knowledge_summaries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_purge_fence('owner_id');--> statement-breakpoint

DROP TRIGGER IF EXISTS document_pipeline_batches_account_purge_fence ON public.document_pipeline_batches;--> statement-breakpoint
CREATE TRIGGER document_pipeline_batches_account_purge_fence
  BEFORE INSERT OR UPDATE ON public.document_pipeline_batches
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_purge_fence('document_id');--> statement-breakpoint

DROP TRIGGER IF EXISTS metadata_reembed_outbox_account_purge_fence ON public.metadata_reembed_outbox;--> statement-breakpoint
CREATE TRIGGER metadata_reembed_outbox_account_purge_fence
  BEFORE INSERT OR UPDATE ON public.metadata_reembed_outbox
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_purge_fence('document_id');--> statement-breakpoint

DROP TRIGGER IF EXISTS document_tags_account_purge_fence ON public.document_tags;--> statement-breakpoint
CREATE TRIGGER document_tags_account_purge_fence
  BEFORE INSERT OR UPDATE ON public.document_tags
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_purge_fence('document_id');--> statement-breakpoint

DROP TRIGGER IF EXISTS attachments_account_purge_fence ON public.attachments;--> statement-breakpoint
CREATE TRIGGER attachments_account_purge_fence
  BEFORE INSERT OR UPDATE ON public.attachments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_purge_fence('document_id');--> statement-breakpoint

DROP TRIGGER IF EXISTS versions_account_purge_fence ON public.versions;--> statement-breakpoint
CREATE TRIGGER versions_account_purge_fence
  BEFORE INSERT OR UPDATE ON public.versions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_purge_fence('document_id');--> statement-breakpoint

DROP TRIGGER IF EXISTS document_embeddings_account_purge_fence ON public.document_embeddings;--> statement-breakpoint
CREATE TRIGGER document_embeddings_account_purge_fence
  BEFORE INSERT OR UPDATE ON public.document_embeddings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_purge_fence('document_id');
