#!/usr/bin/env bash
set -euo pipefail

# Build a publish-shaped package in a disposable directory and exercise the
# two advertised executable entrypoints from a clean npm consumer. This does
# not publish anything and never reads project secrets.
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp_root=$(mktemp -d /mnt/ai_data/tmp/hiai-docs-public-package.XXXXXX)
trap 'rm -rf "$tmp_root"' EXIT

git -C "$repo_root" archive HEAD | tar -x -C "$tmp_root"
cp "$repo_root/package.public.json" "$tmp_root/package.json"

# package.public.json ships the SDK's built output. Build it before staging
# because dist is intentionally ignored by git.
(cd "$repo_root/packages/sdk" && bun run build)
mkdir -p "$tmp_root/packages/sdk"
cp -R "$repo_root/packages/sdk/dist" "$tmp_root/packages/sdk/dist"

npm_cache="$tmp_root/npm-cache"
tarball=$(cd "$tmp_root" && NPM_CONFIG_CACHE="$npm_cache" npm pack --ignore-scripts --json | node -e '
  let input = "";
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => process.stdout.write(JSON.parse(input)[0].filename));
')

consumer="$tmp_root/consumer"
mkdir -p "$consumer"
(cd "$consumer" && NPM_CONFIG_CACHE="$npm_cache" npm init -y >/dev/null && NPM_CONFIG_CACHE="$npm_cache" npm install --ignore-scripts "$tmp_root/$tarball" >/dev/null)

"$consumer/node_modules/.bin/hiai-docs" --help >/dev/null
# MCP uses stdio and exits cleanly when stdin is closed. This verifies that
# its transitive runtime dependencies are available in a clean install.
"$consumer/node_modules/.bin/hiai-docs-mcp" </dev/null >/dev/null

echo "Public package clean-consumer smoke passed"
