#!/usr/bin/env bash
set -euo pipefail
remote=git@github.com:HiAi-gg/dsh-docsmint.git
version=$(node -p "require('./packages/dsh-plugin/package.json').version")
git fetch origin main
source_tree=$(git rev-parse HEAD:packages/dsh-plugin)
if [[ "$source_tree" != "$(git rev-parse origin/main:packages/dsh-plugin)" ]]; then
  echo "Stale package tree; skipping mirror" | tee -a "$GITHUB_STEP_SUMMARY"
  exit 0
fi
npm view "@hiai-gg/dsh-docsmint@$version" --json > "$RUNNER_TEMP/dsh-mirror-published.json" 2>/dev/null || {
  if [[ "$GITHUB_REF" == refs/heads/main ]]; then
    echo "Version $version not published yet; release tag will synchronize it" | tee -a "$GITHUB_STEP_SUMMARY"
    exit 0
  fi
  echo "Published release metadata unavailable" >&2; exit 1
}
node -e 'const p=require(process.env.RUNNER_TEMP+"/dsh-mirror-published.json"); if(p.name!=="@hiai-gg/dsh-docsmint" || p.version!==process.argv[1]) process.exit(1)' "$version"
test -n "$DSH_MIRROR_SSH_KEY"
umask 077
keydir=$(mktemp -d)
trap 'rm -rf -- "$keydir"' EXIT
printf '%s\n' "$DSH_MIRROR_SSH_KEY" > "$keydir/key"
curl --fail --silent --show-error https://api.github.com/meta > "$keydir/meta.json"
node -e 'for(const k of require(process.argv[1]).ssh_keys) console.log("github.com "+k)' "$keydir/meta.json" > "$keydir/known_hosts"
export GIT_SSH_COMMAND="ssh -i $keydir/key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$keydir/known_hosts"
git config user.name docs-mint-bot
git config user.email bot@docsmint.com
split=$(git subtree split --prefix=packages/dsh-plugin HEAD)
expected=$(git ls-remote "$remote" refs/heads/main | cut -f1)
git push --force-with-lease="refs/heads/main:$expected" "$remote" "$split:refs/heads/main"
git fetch "$remote" refs/heads/main
[[ "$(git rev-parse FETCH_HEAD)" == "$split" ]]
[[ "$(git rev-parse FETCH_HEAD^{tree})" == "$source_tree" ]]
{
  echo "Source: $(git rev-parse HEAD)"
  echo "Mirror: $split"
  echo "Version: $version"
  echo "Verified package-root tree: $source_tree"
} | tee -a "$GITHUB_STEP_SUMMARY"
