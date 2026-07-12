-- Rollback-only PostgreSQL smoke for migration 0033.
-- Run after the complete migration journal against both a fresh database and
-- an upgraded database. Any failed assertion aborts with a non-zero status.
\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  smoke_owner uuid := gen_random_uuid();
  smoke_document uuid;
  generated_expression text;
BEGIN
  SELECT pg_get_expr(adbin, adrelid)
  INTO generated_expression
  FROM pg_attrdef
  WHERE adrelid = 'public.documents'::regclass
    AND adnum = (
      SELECT attnum
      FROM pg_attribute
      WHERE attrelid = 'public.documents'::regclass
        AND attname = 'search_vector_simple'
    );

  IF generated_expression NOT LIKE '%regexp_replace%'
    OR generated_expression NOT LIKE '%200000%'
  THEN
    RAISE EXCEPTION 'bounded generated search-vector expression is missing';
  END IF;

  INSERT INTO users (id, email, name)
  VALUES (smoke_owner, smoke_owner || '@migration-smoke.invalid', 'Migration smoke');

  INSERT INTO documents (owner_id, title, content)
  VALUES (
    smoke_owner,
    'large migration smoke',
    'English français português 中文 русский ' ||
      repeat('searchable paragraph ', 70000) ||
      E'\n![inline](data:image/png;base64,' || repeat('A', 1500000) || ')'
  )
  RETURNING id INTO smoke_document;

  IF (SELECT octet_length(content) FROM documents WHERE id = smoke_document) <= 1048575 THEN
    RAISE EXCEPTION 'smoke document did not exceed one MiB';
  END IF;
  IF NOT (SELECT search_vector @@ websearch_to_tsquery('english', 'English') FROM documents WHERE id = smoke_document) THEN
    RAISE EXCEPTION 'English generated-vector search failed after insert';
  END IF;
  IF NOT (SELECT search_vector_simple @@ websearch_to_tsquery('simple', 'français') FROM documents WHERE id = smoke_document) THEN
    RAISE EXCEPTION 'multilingual generated-vector search failed after insert';
  END IF;
  IF (SELECT octet_length(search_vector::text) FROM documents WHERE id = smoke_document) >= 1048575
    OR (SELECT octet_length(search_vector_simple::text) FROM documents WHERE id = smoke_document) >= 1048575
  THEN
    RAISE EXCEPTION 'generated search vector exceeded PostgreSQL limit';
  END IF;

  UPDATE documents
  SET content =
    'Updated español русский English ' ||
    repeat('updated searchable ', 80000) ||
    E'\n![inline](data:image/jpeg;base64,' || repeat('B', 1400000) || ')'
  WHERE id = smoke_document;

  IF NOT (SELECT search_vector @@ websearch_to_tsquery('english', 'updated') FROM documents WHERE id = smoke_document) THEN
    RAISE EXCEPTION 'English generated-vector search failed after update';
  END IF;
  IF NOT (SELECT search_vector_simple @@ websearch_to_tsquery('simple', 'русский') FROM documents WHERE id = smoke_document) THEN
    RAISE EXCEPTION 'multilingual generated-vector search failed after update';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_class tbl ON tbl.oid = i.indrelid
    JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
    JOIN pg_am am ON am.oid = idx.relam
    JOIN pg_attribute attr
      ON attr.attrelid = tbl.oid
      AND attr.attname = 'search_vector'
      AND attr.attnum = ANY(i.indkey)
    WHERE ns.nspname = 'public'
      AND tbl.relname = 'documents'
      AND idx.relname = 'idx_documents_search_vector'
      AND i.indisvalid
      AND i.indisready
      AND i.indnatts = 1
      AND i.indexprs IS NULL
      AND i.indpred IS NULL
      AND am.amname = 'gin'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_class tbl ON tbl.oid = i.indrelid
    JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
    JOIN pg_am am ON am.oid = idx.relam
    JOIN pg_attribute attr
      ON attr.attrelid = tbl.oid
      AND attr.attname = 'search_vector_simple'
      AND attr.attnum = ANY(i.indkey)
    WHERE ns.nspname = 'public'
      AND tbl.relname = 'documents'
      AND idx.relname = 'idx_documents_search_vector_simple'
      AND i.indisvalid
      AND i.indisready
      AND i.indnatts = 1
      AND i.indexprs IS NULL
      AND i.indpred IS NULL
      AND am.amname = 'gin'
  ) THEN
    RAISE EXCEPTION 'generated search-vector GIN indexes are invalid, unready, or target the wrong column';
  END IF;
END
$$;

ROLLBACK;
