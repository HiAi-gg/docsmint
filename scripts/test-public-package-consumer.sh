#!/usr/bin/env bash
set -euo pipefail

# Build a publish-shaped package in a disposable directory and exercise the
# two advertised executable entrypoints from a clean Bun consumer. This does
# not publish anything and never reads project secrets.
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp_root=$(mktemp -d /tmp/docsmint-public-package.XXXXXX)
trap 'rm -rf "$tmp_root"' EXIT

git -C "$repo_root" archive HEAD | tar -x -C "$tmp_root"
cp "$repo_root/package.public.json" "$tmp_root/package.json"

# package.public.json ships the SDK's built output. Build it before staging
# because dist is intentionally ignored by git.
(cd "$repo_root/packages/sdk" && bun run build)
cp -R "$repo_root/packages/sdk/dist" "$tmp_root/dist"

tarballs="$tmp_root/tarballs"
mkdir -p "$tarballs"
tarball_name=$(cd "$tmp_root" && bun pm pack --ignore-scripts --destination "$tarballs" --quiet)
tarball="$tarballs/$(basename "$tarball_name")"

consumer="$tmp_root/consumer"
mkdir -p "$consumer"
(cd "$consumer" && bun init -y >/dev/null && bun add --ignore-scripts "$tarball" >/dev/null)

cp "$repo_root/scripts/fixtures/public-package-consumer.ts" "$consumer/public-package-consumer.ts"
(cd "$consumer" && bun "$repo_root/frontend/node_modules/typescript/bin/tsc" \
  --ignoreConfig \
  --noEmit \
  --strict \
  --skipLibCheck \
  --target ESNext \
  --module ESNext \
  --moduleResolution Bundler \
  public-package-consumer.ts)

if find "$consumer/node_modules/@hiai-gg/docsmint" -path '*/packages/mcp-server/src/*.ts' -print -quit | grep -q .; then
  echo "Packed MCP consumer contains private raw TypeScript"
  exit 1
fi
if rg --quiet '@hiai-docs/' "$consumer/node_modules/@hiai-gg/docsmint/dist" \
  --glob '*.js' --glob '*.d.ts'; then
  echo "Packed MCP consumer contains a private workspace import"
  exit 1
fi

"$consumer/node_modules/.bin/hiai-docs" --help >/dev/null
# MCP uses stdio and exits cleanly when stdin is closed. This verifies that
# its transitive runtime dependencies are available in a clean install.
"$consumer/node_modules/.bin/hiai-docs-mcp" </dev/null >/dev/null

echo "Public package clean-consumer smoke passed"
