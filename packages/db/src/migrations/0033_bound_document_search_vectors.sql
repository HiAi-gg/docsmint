DROP INDEX IF EXISTS "idx_documents_search_vector";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_documents_search_vector_simple";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "search_vector";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "search_vector_simple";--> statement-breakpoint
ALTER TABLE "documents"
  ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      left(
        COALESCE(title, '') || ' ' || regexp_replace(
          COALESCE(content, ''),
          'data:[^[:space:])>]+',
          ' ',
          'g'
        ),
        200000
      )
    )
  ) STORED;--> statement-breakpoint
ALTER TABLE "documents"
  ADD COLUMN "search_vector_simple" tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      left(
        COALESCE(title, '') || ' ' || regexp_replace(
          COALESCE(content, ''),
          'data:[^[:space:])>]+',
          ' ',
          'g'
        ),
        200000
      )
    )
  ) STORED;--> statement-breakpoint
CREATE INDEX "idx_documents_search_vector"
  ON "documents" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "idx_documents_search_vector_simple"
  ON "documents" USING gin ("search_vector_simple");
