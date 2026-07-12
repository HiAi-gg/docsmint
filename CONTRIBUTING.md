# Contributing to hiai-docs

Thanks for your interest in contributing!

## Getting Started

1. Fork the repository
2. Clone your fork
3. Create a feature branch: `git checkout -b feature/my-change`
4. Make your changes
5. Run checks: `bun run lint && bun run typecheck`
6. Commit with a clear message
7. Push and open a Pull Request

## Branch Naming

- `feature/description` — new features
- `fix/description` — bug fixes
- `refactor/description` — code refactoring
- `docs/description` — documentation changes

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add document version diff view
fix: resolve search pagination off-by-one
refactor: extract folder tree into separate component
docs: update API reference for share endpoints
```

## Code Style

- **Runtime**: Bun only (no npm/yarn)
- **Modules**: ESM only (`import`/`export`, no `require`)
- **TypeScript**: strict mode, no `any` types
- **Language**: English only — code, comments, docs, commit messages
- **Validation**: Zod for all API inputs
- **No Playwright**: use agent-browser for E2E tests

## Keyboard Shortcuts

The frontend has a global keyboard registry
(`frontend/src/lib/stores/keyboard.svelte.ts`) with scoped handlers. When
adding a new shortcut:

- **Pick an existing scope** (`global`, `editor`, `dialog`, `list`) or
  introduce a new one in `getShortcutsByScope`. New scopes must be added
  to the `SCOPES_ORDER` array in `ShortcutHelp.svelte` so users can
  discover them via the `?` help overlay.
- **Use the cross-platform modifier syntax**: write `mod+k`, not `cmd+k`
  or `ctrl+k`. The store translates `mod` to `⌘` on macOS and `Ctrl` on
  every other platform, matching the convention used in shadcn-svelte
  examples.
- **Always set `overrideInput`** explicitly. Use `true` when the shortcut
  must fire from inside an input/textarea (e.g. QuickSearch, dialog
  close); use `false` for shortcuts that should only fire outside text
  fields (the default for app-level bindings like `?`).
- **Register on mount, unregister on cleanup**. Always pair
  `registerShortcut` with an `unregisterShortcut` in the component's
  `$effect` cleanup so leaving a page releases the binding.
- **Don't shadow browser/OS defaults**. Reserve `Cmd+1..9` for the
  browser's tab-switching; prefer `Cmd+Shift+Digit` for app-level jumps.
- **Document every shortcut** in `docs/USAGE.md` and add
  a matching `m.shortcut_help_*` message in `frontend/messages/en.json`
  so the `?` overlay stays in sync with the source of truth.

## Project Structure

```
hiai-docs/
├── backend/          # Elysia API (Bun)
├── frontend/         # SvelteKit (Svelte 5 + Tailwind v4)
├── packages/db/      # Drizzle ORM schema + migrations
├── docker-compose.yml
└── .env.example
```

## Testing

```bash
# Backend unit tests
cd backend && bun test

# Frontend tests
cd frontend && bun run test

# Type check everything
bun run typecheck
```

## Pull Request Checklist

- [ ] Code compiles without errors (`bun run typecheck`)
- [ ] Linting passes (`bun run lint`)
- [ ] Tests pass (`bun test`)
- [ ] SDK builds successfully (`cd packages/sdk && bun run build`)
- [ ] No hardcoded secrets or paths
- [ ] Commit messages follow Conventional Commits
- [ ] Changes are focused — one feature/fix per PR

## Extension Guide

hiai-docs exposes three stable integration surfaces. Use these instead of forking core.

### npm SDK — programmatic API access

```bash
bun add @hiai-gg/hiai-docs
```

```ts
import { DocsClient } from "@hiai-gg/hiai-docs";

const docs = new DocsClient({
  baseUrl: "https://your-hiai-docs-host.com",
  apiKey: process.env.HIAI_DOCS_API_KEY ?? "",
});

const { items } = await docs.listDocs();
const results = await docs.search("knowledge base setup");
```

The SDK has no runtime dependencies. Full method list in [packages/sdk/README.md](packages/sdk/README.md).

### Drizzle schema import — shared table definitions

If you share the same PostgreSQL database and want typed queries against hiai-docs tables:

```ts
import { documents, folders, tags } from "@hiai-gg/hiai-docs/schema";
import { drizzle } from "drizzle-orm/postgres-js";
```

Peer deps required: `drizzle-orm`, `postgres`.

### MCP server — AI agent integration

Point a Model Context Protocol client (Claude, Cursor, etc.) at the built-in MCP server:

```bash
bun run mcp:dev
```

The server is in `packages/mcp-server/` and exposes hiai-docs tools (search, read, write) to AI assistants.

### What NOT to add to core

The following belong in downstream products, not in `hiai-docs` itself:

- Product-specific analytics or usage tracking
- White-label UI themes
- Custom auth providers (use `.env`-configurable Better Auth plugins instead)
- Domain-specific document schemas (extend via the API, not the Drizzle schema)
- Features that require new env vars not related to the core knowledge-base use case

If you are unsure, open a GitHub Discussion before writing code.

---

## Questions?

Open an issue or start a discussion on GitHub.
