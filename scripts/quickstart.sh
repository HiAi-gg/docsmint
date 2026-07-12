#!/usr/bin/env bash
set -euo pipefail

# One-command local/public quickstart. Users only choose OpenRouter or Ollama
# in the ignored root .env; infrastructure secrets are generated automatically.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
umask 077

if [[ ! -f "$ENV_FILE" ]]; then
	install -m 600 "${ROOT_DIR}/.env.example" "$ENV_FILE"
	printf '%s\n' "Created $ENV_FILE from .env.example"
fi

read_value() {
	local key="$1"
	awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

set_value() {
	local key="$1" value="$2" tmp="${ENV_FILE}.tmp.$$"
	awk -v key="$key" -v value="$value" '
		BEGIN { replaced = 0 }
		$0 ~ ("^" key "=") { print key "=" value; replaced = 1; next }
		{ print }
		END { if (!replaced) print key "=" value }
	' "$ENV_FILE" > "$tmp"
	chmod 600 "$tmp"
	mv "$tmp" "$ENV_FILE"
}

generate_secret_if_placeholder() {
	local key="$1" current
	current="$(read_value "$key")"
	if [[ -z "$current" || "$current" == change-me* || "$current" == replace-with* ]]; then
		set_value "$key" "$(openssl rand -hex 32)"
	fi
}

for secret in DB_PASSWORD HIAI_APP_PASSWORD BETTER_AUTH_SECRET CSRF_SECRET \
	WEBHOOK_SECRET STORAGE_SECRET_KEY HIAI_DOCS_API_KEY API_KEY_HASH_SECRET \
	API_KEY_ENCRYPTION_SECRET; do
	generate_secret_if_placeholder "$secret"
done

owner_id="$(read_value OWNER_ID)"
if [[ -z "$owner_id" || "$owner_id" == "00000000-0000-4000-8000-000000000001" || "$owner_id" == your-user-* ]]; then
	hex="$(openssl rand -hex 16)"
	set_value OWNER_ID "${hex:0:8}-${hex:8:4}-4${hex:13:3}-8${hex:17:3}-${hex:20:12}"
fi

db_name="$(read_value DB_NAME)"
db_name="${db_name:-hiai_docs}"
db_port="$(read_value DB_PORT)"
db_port="${db_port:-5437}"
db_password="$(read_value DB_PASSWORD)"
app_password="$(read_value HIAI_APP_PASSWORD)"
set_value DATABASE_URL "postgresql://hiai_app:${app_password}@localhost:${db_port}/${db_name}"
set_value MIGRATION_DATABASE_URL "postgresql://aiuser:${db_password}@localhost:${db_port}/${db_name}"

provider="$(read_value AI_PROVIDER)"
provider="${provider:-openrouter}"
ollama_port="$(read_value OLLAMA_PORT)"
ollama_port="${ollama_port:-11434}"
set_value AI_PROVIDER "$provider"
set_value OLLAMA_PORT "$ollama_port"

case "$provider" in
	openrouter)
		set_value PROVIDER_LIMITER_MODE "remote"
		set_value EMBEDDING_BASE_URL "https://openrouter.ai/api/v1"
		set_value EMBEDDING_MODEL "openai/text-embedding-3-small"
		set_value EMBEDDING_FALLBACK_BASE_URL "https://openrouter.ai/api/v1"
		set_value EMBEDDING_FALLBACK_MODEL "baai/bge-m3"
		set_value GRAPH_EXTRACT_BASE_URL "https://openrouter.ai/api/v1"
		set_value GRAPH_EXTRACT_MODEL "mistralai/ministral-14b-2512"
		set_value GRAPH_EXTRACT_FALLBACK_BASE_URL "https://openrouter.ai/api/v1"
		set_value GRAPH_EXTRACT_FALLBACK_MODEL "google/gemma-4-31b-it"
		set_value SEARCH_EXPANSION_BASE_URL "https://openrouter.ai/api/v1"
		set_value SEARCH_EXPANSION_MODEL "mistralai/ministral-14b-2512"
		set_value SEARCH_EXPANSION_FALLBACK_BASE_URL "https://openrouter.ai/api/v1"
		set_value SEARCH_EXPANSION_FALLBACK_MODEL "google/gemma-4-31b-it"
		;;
	ollama)
		set_value PROVIDER_LIMITER_MODE "local"
		ollama_url="http://host.docker.internal:${ollama_port}/v1"
		set_value OPENROUTER_API_KEY ""
		set_value EMBEDDING_BASE_URL "$ollama_url"
		set_value EMBEDDING_API_KEY ""
		set_value EMBEDDING_MODEL "bge-m3"
		set_value EMBEDDING_FALLBACK_BASE_URL "$ollama_url"
		set_value EMBEDDING_FALLBACK_API_KEY ""
		set_value EMBEDDING_FALLBACK_MODEL "bge-m3"
		set_value GRAPH_EXTRACT_BASE_URL "$ollama_url"
		set_value GRAPH_EXTRACT_API_KEY ""
		set_value GRAPH_EXTRACT_MODEL "qwen3:8b"
		set_value GRAPH_EXTRACT_FALLBACK_BASE_URL "$ollama_url"
		set_value GRAPH_EXTRACT_FALLBACK_API_KEY ""
		set_value GRAPH_EXTRACT_FALLBACK_MODEL "qwen3:8b"
		set_value SEARCH_EXPANSION_BASE_URL "$ollama_url"
		set_value SEARCH_EXPANSION_API_KEY ""
		set_value SEARCH_EXPANSION_MODEL "qwen3:8b"
		set_value SEARCH_EXPANSION_FALLBACK_BASE_URL "$ollama_url"
		set_value SEARCH_EXPANSION_FALLBACK_API_KEY ""
		set_value SEARCH_EXPANSION_FALLBACK_MODEL "qwen3:8b"
		;;
	*)
		printf 'Unsupported AI_PROVIDER=%s (use openrouter or ollama)\n' "$provider" >&2
		exit 2
		;;
esac

printf 'Starting hiai-docs with AI_PROVIDER=%s\n' "$provider"
if [[ "$provider" == "openrouter" ]]; then
	key="$(read_value OPENROUTER_API_KEY)"
	if [[ -z "$key" || "$key" == change-me* ]]; then
		printf '%s\n' 'OPENROUTER_API_KEY is still a placeholder; add it to .env before expecting embeddings/GraphRAG.' >&2
	fi
else
	printf 'Ollama endpoint: http://host.docker.internal:%s\n' "$ollama_port"
fi

cd "$ROOT_DIR"
exec docker compose --env-file "$ENV_FILE" up -d --build
