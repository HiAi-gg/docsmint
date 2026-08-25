-- Cleanup staging must lock its authoritative parent before any actor fence
-- advisory. This matches document mutation order and prevents
-- actor-advisory -> parent-row inversion during attachment cleanup.
DROP TRIGGER IF EXISTS attachment_storage_cleanup_outbox_account_purge_fence_insert
  ON public.attachment_storage_cleanup_outbox;--> statement-breakpoint
CREATE TRIGGER attachment_storage_cleanup_outbox_account_purge_fence_insert
  AFTER INSERT ON public.attachment_storage_cleanup_outbox
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_account_purge_fence(
    'parent_document:document_id', 'direct:requested_by_user_id'
  );
