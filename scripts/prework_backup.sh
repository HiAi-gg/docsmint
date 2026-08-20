#!/bin/bash
# hiai-docs pre-work backup script
# Usage: ./scripts/prework_backup.sh [project_name]

set -euo pipefail

PROJECT_NAME="${1:-docsmint}"
: "${DOCSMINT_BACKUP_ROOT:?Set DOCSMINT_BACKUP_ROOT to an operator-owned backup directory}"
BACKUP_DIR="${DOCSMINT_BACKUP_ROOT%/}/${PROJECT_NAME}/$(date +%Y-%m-%d_%H%M%S)"

mkdir -p "$BACKUP_DIR"

echo "Creating backup snapshot for ${PROJECT_NAME}..."

# Backup database if running
if docker compose ps postgres 2>/dev/null | grep -q "Up"; then
  echo "Backing up PostgreSQL..."
  docker compose exec -T postgres pg_dump -U aiuser hiai_docs > "${BACKUP_DIR}/database.sql" 2>/dev/null || echo "DB backup skipped (not running or not accessible)"
fi

# Secrets are deliberately excluded. Back up provider and application secrets
# through the operator's secret manager, never into an ad-hoc filesystem dump.

echo "Backup created at: ${BACKUP_DIR}"
