#!/usr/bin/env bash
set -euo pipefail

: "${HIAI_APP_PASSWORD:?HIAI_APP_PASSWORD must be set before initializing PostgreSQL}"

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$HIAI_APP_PASSWORD" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'hiai_app') THEN
    CREATE ROLE hiai_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

SELECT format('ALTER ROLE hiai_app PASSWORD %L', :'app_password') \gexec
ALTER ROLE hiai_app SET search_path = public, ag_catalog;
SQL
