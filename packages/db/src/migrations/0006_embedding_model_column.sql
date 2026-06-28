ALTER TABLE "document_embeddings" ADD COLUMN "embedding_model" text DEFAULT '' NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "document_embeddings_embedding_model_idx" ON "document_embeddings" ("embedding_model");--> statement-breakpoint
