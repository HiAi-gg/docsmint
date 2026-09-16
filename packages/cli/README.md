# DocsMint CLI

Find project knowledge, read documents, and capture new notes without leaving
your terminal. This Bun-native client connects to a running
[DocsMint](https://github.com/HiAi-gg/docsmint) instance.

Prefer to try the product before operating a server? Explore
[managed DocsMint](https://docsmint.com), or follow the
[self-hosted quickstart](https://github.com/HiAi-gg/docsmint#quickstart).

## Run the published CLI

```bash
bunx --package @hiai-gg/docsmint docsmint --help
```

The public package contains the canonical `docsmint` binary. The legacy
`hiai-docs` binary remains a compatibility alias; there is no separate public
CLI package. From a source checkout use
`bun --filter '@hiai-docs/cli' dev -- <args>`.

## Configure

```bash
HIAI_DOCS_URL=http://localhost:50700 \
HIAI_DOCS_API_KEY='your-global-or-category-key' \
bunx --package @hiai-gg/docsmint docsmint list
```

Resolution order is environment, `~/.hiai-docs/config.json`, then defaults (`http://localhost:50700`, no key). `init` and `config` persist credentials with owner-only permissions on POSIX systems: directory `0700`, file `0600`.

```bash
bunx --package @hiai-gg/docsmint docsmint init \
  --url https://docs.example.com --key '…'
bunx --package @hiai-gg/docsmint docsmint config --show
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
