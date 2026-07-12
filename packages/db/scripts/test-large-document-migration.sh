#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
cd "$project_root"

suffix=$$
fresh_db="hiai_docs_large_fresh_${suffix}"
upgrade_db="hiai_docs_large_upgrade_${suffix}"
log_file="/tmp/hiai-docs-large-migration-${suffix}.log"

cleanup() {
	docker compose exec -T postgres dropdb -U aiuser --if-exists "$fresh_db" >/dev/null 2>&1 || true
	docker compose exec -T postgres dropdb -U aiuser --if-exists "$upgrade_db" >/dev/null 2>&1 || true
	rm -f "$log_file"
}
trap cleanup EXIT INT TERM

run_migrate() {
	database=$1
	mode=$2
	if [ "$mode" = "pre0033" ]; then
		command='tmp=/tmp/migrations-pre0033; rm -rf "$tmp"; cp -R src/migrations "$tmp"; rm -f "$tmp/0033_bound_document_search_vectors.sql"; JOURNAL="$tmp/meta/_journal.json" bun -e '\''const path=process.env.JOURNAL; const journal=await Bun.file(path).json(); journal.entries=journal.entries.filter((entry)=>entry.idx<=32); await Bun.write(path, JSON.stringify(journal));'\''; url="${MIGRATION_DATABASE_URL%/*}/'"$database"'"; SMOKE_URL="$url" SMOKE_FOLDER="$tmp" bun -e '\''import { runMigrations } from "./scripts/migrate.ts"; await runMigrations(process.env.SMOKE_URL, { migrationsFolder: process.env.SMOKE_FOLDER });'\''' 
	else
		command='url="${MIGRATION_DATABASE_URL%/*}/'"$database"'"; bun run scripts/migrate.ts --owner-url="$url"'
	fi
	if ! docker compose run --rm --entrypoint sh migrate -lc "$command" >"$log_file" 2>&1; then
		cat "$log_file" >&2
		return 1
	fi
}

create_bootstrapped_database() {
	database=$1
	docker compose exec -T postgres createdb -U aiuser "$database"
	docker compose exec -T postgres psql -U aiuser -d "$database" -v ON_ERROR_STOP=1 -q -c \
		"CREATE EXTENSION IF NOT EXISTS age;"
}

run_sql_smoke() {
	database=$1
	docker compose exec -T postgres psql -U aiuser -d "$database" -q -f - \
		< packages/db/scripts/large-document-search-smoke.sql
}

docker compose build migrate >"$log_file" 2>&1

printf '%s\n' '[1/4] fresh database: bootstrap + complete migration journal'
create_bootstrapped_database "$fresh_db"
run_migrate "$fresh_db" full
run_sql_smoke "$fresh_db"
fresh_count=$(docker compose exec -T postgres psql -U aiuser -d "$fresh_db" -Atqc \
	"SELECT count(*) FROM drizzle.__drizzle_migrations")
[ "$fresh_count" = "34" ]
printf '      passed (%s journal entries)\n' "$fresh_count"

printf '%s\n' '[2/4] upgraded database: bootstrap + journal through 0032'
create_bootstrapped_database "$upgrade_db"
run_migrate "$upgrade_db" pre0033
pre_count=$(docker compose exec -T postgres psql -U aiuser -d "$upgrade_db" -Atqc \
	"SELECT count(*) FROM drizzle.__drizzle_migrations")
[ "$pre_count" = "33" ]
printf '      passed (%s journal entries)\n' "$pre_count"

printf '%s\n' '[3/4] upgraded database: apply 0033 from the canonical journal'
run_migrate "$upgrade_db" full
post_count=$(docker compose exec -T postgres psql -U aiuser -d "$upgrade_db" -Atqc \
	"SELECT count(*) FROM drizzle.__drizzle_migrations")
[ "$post_count" = "34" ]
printf '      passed (%s -> %s journal entries)\n' "$pre_count" "$post_count"

printf '%s\n' '[4/4] upgraded database: rollback-only large document smoke'
run_sql_smoke "$upgrade_db"
printf '%s\n' '      passed (insert, update, multilingual search, generated vectors, exact ready GIN indexes)'
