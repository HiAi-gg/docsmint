CREATE TABLE "folder_create_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" text NOT NULL,
  "actor_user_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE CASCADE,
  "idempotency_key" text NOT NULL,
  "folder_id" uuid NOT NULL,
  "request_fingerprint" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "folder_create_operations_workspace_actor_key_unique" UNIQUE("workspace_id", "actor_user_id", "idempotency_key"),
  CONSTRAINT "folder_create_operations_idempotency_key_check" CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX "folder_create_operations_folder_idx" ON "folder_create_operations" USING btree ("folder_id");--> statement-breakpoint
ALTER TABLE "folder_create_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "folder_create_operations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "folder_create_operations_owner" ON "folder_create_operations"
  FOR ALL TO hiai_app
  USING (
    actor_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND workspace_id = COALESCE(NULLIF(current_setting('app.current_workspace_id', true), ''), 'personal:' || current_setting('app.current_user_id', true))
  )
  WITH CHECK (
    actor_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND workspace_id = COALESCE(NULLIF(current_setting('app.current_workspace_id', true), ''), 'personal:' || current_setting('app.current_user_id', true))
  );
GRANT SELECT, INSERT ON "folder_create_operations" TO hiai_app;
