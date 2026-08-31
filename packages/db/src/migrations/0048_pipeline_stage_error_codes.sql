ALTER TABLE public.document_pipeline_runs
  ADD COLUMN IF NOT EXISTS graph_error_code text,
  ADD COLUMN IF NOT EXISTS summarize_error_code text;
