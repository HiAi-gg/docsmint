-- Existing volumes may predate the PostgreSQL bootstrap that configured
-- AGE's planner hook. Apply the database-level setting for pooled sessions.
DO $$
BEGIN
  EXECUTE format(
    'ALTER DATABASE %I SET session_preload_libraries = %L',
    current_database(),
    'age'
  );
END
$$;
