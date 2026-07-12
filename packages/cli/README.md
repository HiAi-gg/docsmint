# hiai-docs CLI

Bun-native terminal client for a running [hiai-docs](https://github.com/HiAi-gg/hiai-docs) instance.

## Run the published CLI

```bash
bunx --package @hiai-gg/hiai-docs hiai-docs --help
```

The public package contains the `hiai-docs` binary; there is no separate public `@hiai-docs/cli` install requirement. From a source checkout use `bun --filter '@hiai-docs/cli' dev -- <args>`.

## Configure

```bash
HIAI_DOCS_URL=http://localhost:50700 \
HIAI_DOCS_API_KEY='your-global-or-category-key' \
bunx --package @hiai-gg/hiai-docs hiai-docs list
```

Resolution order is environment, `~/.hiai-docs/config.json`, then defaults (`http://localhost:50700`, no key). `init` and `config` persist credentials with owner-only permissions on POSIX systems: directory `0700`, file `0600`.

```bash
bunx --package @hiai-gg/hiai-docs hiai-docs init \
  --url https://docs.example.com --key '…'
bunx --package @hiai-gg/hiai-docs hiai-docs config --show
```

Use a global key for all owner content or a category key for least-privilege access. Category permissions are explicit and non-hierarchical: `read` permits list/read/search/export; `edit` permits existing-content updates/snapshots; `write` permits create/move/delete operations. Combine permissions when needed. Key lifecycle operations themselves require a Better Auth browser session and are not CLI commands.

## Commands

```text
list [--folder UUID] [--tag UUID] [--page N] [--limit N]
read ID
create --title TITLE [--content MARKDOWN] [--folder UUID]
update ID [--title TITLE] [--content MARKDOWN] [--folder UUID]
delete ID [--yes]
search QUERY [--limit N] [--folder UUID] [--tags a,b]
snapshot ID --name LABEL [--description TEXT]
history ID [--snapshots-only]
restore ID --version VERSION_ID
export ID [--output FILE]
folders [--parent UUID]
folder-create --name NAME [--parent UUID]
config [--url URL] [--key KEY] [--show]
init --url URL --key KEY
```

The CLI routes through the public REST API. Snapshot creation uses `/api/documents/:id/versions`; export uses `/api/documents/:id/export` and returns Markdown.

## Development

```bash
cd packages/cli
bun run test
bun run typecheck
bun run dev -- --help
```
