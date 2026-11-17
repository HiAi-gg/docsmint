CREATE TABLE "attachment_upload_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" text NOT NULL,
  "actor_user_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE CASCADE,
  "document_id" uuid NOT NULL REFERENCES "public"."documents"("id") ON DELETE CASCADE,
  "idempotency_key" text NOT NULL,
  "request_fingerprint" text NOT NULL,
  "source_sha256" text NOT NULL,
  "storage_key" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "attachment_upload_operations_idempotency_key_check" CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT "attachment_upload_operations_source_sha256_check" CHECK (source_sha256 ~ '^[a-f0-9]{64}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX "attachment_upload_operations_actor_document_key_unique" ON "attachment_upload_operations"
  ("workspace_id", "actor_user_id", "document_id", "idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "attachment_upload_operations_storage_key_unique" ON "attachment_upload_operations" ("storage_key");--> statement-breakpoint
ALTER TABLE "attachment_upload_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attachment_upload_operations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "attachment_upload_operations_owner" ON "attachment_upload_operations"
  FOR ALL TO hiai_app
  USING (
    actor_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND workspace_id = COALESCE(NULLIF(current_setting('app.current_workspace_id', true), ''), 'personal:' || current_setting('app.current_user_id', true))
  )
  WITH CHECK (
    actor_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND workspace_id = COALESCE(NULLIF(current_setting('app.current_workspace_id', true), ''), 'personal:' || current_setting('app.current_user_id', true))
  );--> statement-breakpoint
GRANT SELECT, INSERT ON "attachment_upload_operations" TO hiai_app;
