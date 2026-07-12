#!/bin/bash
# hiai-docs health-check script
# Usage: ./scripts/health-check.sh
#
# Checks liveness/readiness of every service in the hiai-docs stack.
# Exits 0 only if all checks pass; exits 1 if any check fails.
#
# Environment overrides (all optional):
#   API_PORT    default 50700
#   DB_PORT     default 5437
#   DB_USER     default aiuser
#   DB_NAME     default hiai_docs
#   DB_HOST     default localhost
#   REDIS_PORT  default 6384  (matches docker-compose.yml default)
#   OLLAMA_URL  default http://localhost:11434
#   STORAGE_PORT  default 50702 (host-published SeaweedFS S3 gateway)
#
# Example:
#   ./scripts/health-check.sh
#   REDIS_PORT=6380 API_PORT=50700 ./scripts/health-check.sh

set -euo pipefail

API_PORT="${API_PORT:-50700}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5437}"
DB_USER="${DB_USER:-aiuser}"
DB_NAME="${DB_NAME:-hiai_docs}"
REDIS_PORT="${REDIS_PORT:-6384}"
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
STORAGE_PORT="${STORAGE_PORT:-50702}"

fail=0

check() {
  local name="$1"
  local cmd="$2"
  if eval "$cmd" >/dev/null 2>&1; then
    echo "  ✅ $name"
  else
    echo "  ❌ $name"
    fail=1
  fi
}

echo "hiai-docs Health Checks"
echo "======================="
echo "API:        http://localhost:${API_PORT}/api/health"
echo "PostgreSQL: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
echo "Redis:      localhost:${REDIS_PORT}"
echo "Ollama:     ${OLLAMA_URL}"
echo "SeaweedFS:  http://localhost:${STORAGE_PORT}/status"
echo ""

check "API"        "curl -fsS http://localhost:${API_PORT}/api/health"
check "PostgreSQL" "psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d ${DB_NAME} -c 'SELECT 1'"
check "Redis"      "redis-cli -p ${REDIS_PORT} ping"
check "Ollama"     "curl -fsS ${OLLAMA_URL}/api/tags"
check "SeaweedFS"  "curl -fsS http://localhost:${STORAGE_PORT}/status"

echo ""
if [ "$fail" -eq 0 ]; then
  echo "✅ All services healthy"
  exit 0
else
  echo "❌ One or more services failed"
  echo ""
  echo "Troubleshooting:"
  echo "  - Start the stack:  docker compose up -d"
  echo "  - Tail logs:        docker compose logs -f <service>"
  echo "  - Per-service healthchecks are defined in docker-compose.yml"
  exit 1
fi
