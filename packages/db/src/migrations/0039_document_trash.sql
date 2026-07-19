-- Documents are soft-deleted first so a tenant can restore them within the
-- product retention window. Physical deletion remains explicit via the trash
-- purge route and preserves the existing foreign-key cascade behavior.
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_workspace_deleted_at_idx"
  ON "documents" ("workspace_id", "deleted_at");
