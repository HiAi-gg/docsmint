#!/bin/bash
# hiai-docs pre-work backup script
# Usage: ./scripts/prework_backup.sh [project_name]

set -euo pipefail

PROJECT_NAME="${1:-hiai-docs}"
BACKUP_DIR="/mnt/ai_data/backup/${PROJECT_NAME}/$(date +%Y-%m-%d_%H%M%S)"

mkdir -p "$BACKUP_DIR"

echo "Creating backup snapshot for ${PROJECT_NAME}..."

# Backup database if running
if docker compose ps postgres 2>/dev/null | grep -q "Up"; then
  echo "Backing up PostgreSQL..."
  docker compose exec -T postgres pg_dump -U aiuser hiai_docs > "${BACKUP_DIR}/database.sql" 2>/dev/null || echo "DB backup skipped (not running or not accessible)"
fi

# Backup .env
if [ -f ".env" ]; then
  cp .env "${BACKUP_DIR}/.env.bak"
fi

echo "Backup created at: ${BACKUP_DIR}"
