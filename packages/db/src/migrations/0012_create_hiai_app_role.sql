-- 0012_create_hiai_app_role.sql
--
-- Create the non-superuser application role `hiai_app` so that RLS
-- policies are actually enforced at runtime. The `aiuser` role is
-- implicitly created as SUPERUSER + BYPASSRLS by the PostgreSQL Docker
-- entrypoint (POSTGRES_USER=aiuser), which means `FORCE ROW LEVEL
-- SECURITY` is bypassed whenever the app connects as `aiuser`. This
-- migration:
--
--   1. Creates `hiai_app` with NOSUPERUSER NOBYPASSRLS and a LOGIN
--      password sourced from `current_setting('hiai_app.password')`.
--      Fresh Docker installs create the role in the PostgreSQL init shell
--      with HIAI_APP_PASSWORD before this migration runs. External
--      migration owners must set the setting explicitly.
--   2. Grants CONNECT on the current database, USAGE on `public` and
--      `ag_catalog`, and DML on all existing/future tables in
--      `public`. Apache AGE functions/types in `ag_catalog` are
--      granted EXECUTE/USAGE so the application can call `cypher()`
--      and read `agtype` without BYPASSRLS.
--
-- This file is intentionally idempotent — re-running the migration
-- is safe; the DO block skips role creation when the role already
-- exists and GRANTs are additive.

-- ---------------------------------------------------------------------------
-- 1. Create the role (NOSUPERUSER, NOBYPASSRLS, LOGIN, no replication).
--    Password resolution order:
--      a) `current_setting('hiai_app.password', true)` — operator override
--      b) no fallback — fail clearly when the operator omitted the secret
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_password text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hiai_app') THEN
    v_password := nullif(current_setting('hiai_app.password', true), '');
    IF v_password IS NULL THEN
      RAISE EXCEPTION 'hiai_app.password must be set before creating the runtime role';
    END IF;
    EXECUTE format(
      'CREATE ROLE hiai_app WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
      v_password
    );
  END IF;
END
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Database + schema grants.
-- ---------------------------------------------------------------------------
DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO hiai_app', current_database()); END $$;--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO hiai_app;--> statement-breakpoint
GRANT USAGE ON SCHEMA ag_catalog TO hiai_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Existing objects: tables / sequences / functions / types.
--    EXECUTE on functions in ag_catalog is required so hiai_app can call
--    cypher(), create_graph(), graphid_in/out (used by the Cypher
--    function dispatch) without owning the extension. USAGE on types
--    lets hiai_app reference agtype / graphid / label_kind in FROM/WHERE
--    clauses.
--
--    Note: PostgreSQL does NOT support `GRANT USAGE ON ALL TYPES IN
--    SCHEMA ...` (only TABLE/SEQUENCE/FUNCTION accept the ALL-IN-SCHEMA
--    form). We iterate pg_type in a DO block to grant USAGE on every
--    existing user-defined type. Future types are handled by
--    ALTER DEFAULT PRIVILEGES further down.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hiai_app;--> statement-breakpoint
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO hiai_app;--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO hiai_app;--> statement-breakpoint

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ag_catalog TO hiai_app;--> statement-breakpoint

-- Iterate all user-defined types in `public` and `ag_catalog` and grant
-- USAGE. Excludes pseudo/built-in types (typtype = 'p' or typname in
-- the standard 'unknown'/'any*' family) and the auto-generated array
-- shells ('_' prefix). Idempotent: GRANT USAGE on a type is additive.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, t.typname AS type_name
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname IN ('public', 'ag_catalog')
      AND t.typtype IN ('e', 'c', 'b', 'r', 'm', 'd')  -- enum, composite, base, range, multirange, domain
      AND t.typname NOT LIKE '\_%'                     -- skip array shells (_int4, etc.)
      AND t.typname NOT IN ('unknown')                 -- skip built-in pseudo types
  LOOP
    EXECUTE format('GRANT USAGE ON TYPE %I.%I TO hiai_app', r.schema_name, r.type_name);
  END LOOP;
END
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Default privileges: future objects created by the migration/admin
--    role automatically inherit the same grants so new tables stay
--    accessible to the app role. CURRENT_USER is the actual migration
--    owner (for example aiuser, docsmint, or a managed-database owner).
-- ---------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hiai_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO hiai_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO hiai_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  GRANT USAGE ON TYPES TO hiai_app;--> statement-breakpoint

-- Apache AGE types are created by the infrastructure/migration owner;
-- the default-privileges clause also picks up future types/functions if
-- AGE is upgraded by that same owner.
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA ag_catalog
  GRANT EXECUTE ON FUNCTIONS TO hiai_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA ag_catalog
  GRANT USAGE ON TYPES TO hiai_app;--> statement-breakpoint
