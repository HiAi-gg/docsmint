CREATE UNIQUE INDEX IF NOT EXISTS "attachments_storage_key_unique"
ON "attachments" USING btree ("storage_key");
