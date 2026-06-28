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
- **Document every shortcut** in `docs/keyboard-shortcuts.md` and add
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
- [ ] No hardcoded secrets or paths
- [ ] Commit messages follow Conventional Commits
- [ ] Changes are focused — one feature/fix per PR

## Questions?

Open an issue or start a discussion on GitHub.
