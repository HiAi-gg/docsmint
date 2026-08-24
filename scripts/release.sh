#!/bin/bash
# DocsMint local release-image helper
# Usage: ./scripts/release.sh [version]
#   version: committed semver release version (default: package.public.json)
#
# Environment:
#   REGISTRY  container registry (default: ghcr.io/hiai-gg)
#
# Example:
#   ./scripts/release.sh v0.7.0

set -euo pipefail

if ! command -v bun >/dev/null 2>&1; then
	echo "❌ Bun is required to validate committed release metadata."
	exit 1
fi

VERSION="${1:-$(bun -e 'console.log((await Bun.file("package.public.json").json()).version)')}"
VERSION="${VERSION#v}"
REGISTRY="${REGISTRY:-ghcr.io/hiai-gg}"
IMAGE_NAME="${IMAGE_NAME:-docsmint}"

if [ "${PUSH:-0}" = "1" ]; then
	echo "PUSH is not supported by this local helper. Publish only through the validated CI release workflow."
	exit 1
fi

# Sanity: must be run from project root (where docker-compose.yml lives)
if [ ! -f "docker-compose.yml" ]; then
  echo "❌ docker-compose.yml not found in current directory."
  echo "   Run this script from the hiai-docs project root."
  exit 1
fi

bun run scripts/release-version-validator.ts "v${VERSION}"

# Sanity: docker must be available
if ! command -v docker >/dev/null 2>&1; then
  echo "❌ docker is required but not installed."
  exit 1
fi

# Sanity: docker compose v2 must be available
if ! docker compose version >/dev/null 2>&1; then
  echo "❌ docker compose v2 is required (got docker-compose v1 or none)."
  exit 1
fi

echo "==> Building DocsMint v${VERSION} (registry: ${REGISTRY}/${IMAGE_NAME})"
echo ""

# Build the three release images (postgres/redis/etc. are upstream dependencies).
echo "--- Building api image ---"
docker compose build api

echo ""
echo "--- Building web image ---"
docker compose build web

echo ""
echo "--- Building caddy image ---"
docker compose build caddy

echo ""
echo "==> Tagging images"

for role in api web caddy; do
  docker tag "${IMAGE_NAME}-${role}:local" "${REGISTRY}/${IMAGE_NAME}-${role}:${VERSION}"
  docker tag "${IMAGE_NAME}-${role}:local" "${REGISTRY}/${IMAGE_NAME}-${role}:latest"
done

echo ""
echo "==> Built images:"
docker images --format "  {{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}" \
  | grep -E "(${REGISTRY}/${IMAGE_NAME}-(api|web|caddy)|${IMAGE_NAME}-(api|web|caddy))" \
  || true

echo ""
echo "==> Local images only. The helper never pushes images."
