ALTER TABLE "documents" ADD COLUMN "last_significant_hash" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "last_significant_update_at" timestamp;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "pending_minor_changes" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "metadata_changed_at" timestamp;--> statement-breakpoint
CREATE INDEX "idx_documents_pending_minor_idle" ON "documents" USING btree ("last_significant_update_at") WHERE "documents"."pending_minor_changes" = true;--> statement-breakpoint
CREATE INDEX "idx_documents_metadata_changed" ON "documents" USING btree ("metadata_changed_at") WHERE "documents"."metadata_changed_at" IS NOT NULL;